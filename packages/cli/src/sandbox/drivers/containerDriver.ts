/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec, execSync, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { parse } from 'shell-quote';
import type {
  SandboxDriver,
  SandboxDriverCapabilities,
  SandboxDriverContext,

  coreEvents,
  FatalSandboxError,
  debugLogger,
  GEMINI_DIR,
  homedir,
  type SandboxConfig} from '@google/gemini-cli-core';
import {
  getContainerPath,
  shouldUseCurrentUserInSandbox,
  parseImageName,
  ports,
  entrypoint,
  LOCAL_DEV_SANDBOX_IMAGE_NAME,
  SANDBOX_NETWORK_NAME,
  SANDBOX_PROXY_NAME,
} from '../../utils/sandboxUtils.js';

const execAsync = promisify(exec);

/**
 * Container-based sandbox driver for Docker, Podman, and gVisor (runsc).
 *
 * Extracted from packages/cli/src/utils/sandbox.ts lines 234-799.
 * This handles the full container lifecycle including:
 * - Image validation and pulling (ensureSandboxImageIsPresent)
 * - Volume mounts: workspace, home, tmpdir, settings, gcloud, ADC
 * - Custom mounts: SANDBOX_MOUNTS, config.allowedPaths
 * - Port exposure: SANDBOX_PORTS, DEBUG_PORT
 * - Proxy container with separate Docker network
 * - User/UID/GID mapping for rootless Podman
 * - Environment variable forwarding
 */
export class ContainerDriver implements SandboxDriver {
  readonly name: string;
  readonly description: string;

  readonly capabilities: SandboxDriverCapabilities = {
    supportsNetworkIsolation: true,
    supportsFileSystemRestrictions: true,
    supportsImageBuilding: true,
    requiresPreExistingContainer: false,
    supportedPlatforms: ['darwin', 'linux'],
    maxAllowedPaths: Infinity,
  };

  constructor(
    private readonly command: 'docker' | 'podman',
    private readonly runtime?: string,
  ) {
    this.name = runtime === 'runsc' ? 'gvisor' : command;
    this.description =
      runtime === 'runsc'
        ? 'gVisor (runsc) — kernel-level isolation via Docker'
        : `${command} — container-based sandboxing`;
  }

  async detect(): Promise<boolean> {
    try {
      const { default: commandExists } = await import('command-exists');
      if (!commandExists.sync(this.command)) return false;
      // gVisor additionally needs the runsc runtime binary
      if (this.runtime === 'runsc') {
        return commandExists.sync('runsc');
      }
      return true;
    } catch {
      return false;
    }
  }

  async validate(config: SandboxConfig): Promise<void> {
    const image = config.image;
    if (!image) throw new FatalSandboxError('Sandbox image is required');
    if (!/^[a-zA-Z0-9_.:/-]+$/.test(image)) {
      throw new FatalSandboxError('Invalid sandbox image name');
    }

    // Ensure image is available (extracted from sandbox.ts:291-300)
    if (!(await this.ensureSandboxImageIsPresent(image))) {
      const remedy =
        image === LOCAL_DEV_SANDBOX_IMAGE_NAME
          ? 'Try running `npm run build:all` or `npm run build:sandbox` under the gemini-cli repo to build it locally, or check the image name and your network connection.'
          : 'Please check the image name, your network connection, or notify gemini-cli-dev@google.com if the issue persists.';
      throw new FatalSandboxError(
        `Sandbox image '${image}' is missing or could not be pulled. ${remedy}`,
      );
    }
  }

  async execute(context: SandboxDriverContext): Promise<number> {
    // The actual runtime command: runsc uses docker with --runtime=runsc
    const command = this.runtime === 'runsc' ? 'docker' : this.command;

    debugLogger.log(`hopping into sandbox (command: ${command}) ...`);

    const image = context.config.image;
    if (!image) throw new FatalSandboxError('Sandbox image is required');

    const workdir = path.resolve(context.workdir);
    const containerWorkdir = getContainerPath(workdir);

    // Handle BUILD_SANDBOX (extracted from sandbox.ts:259-289)
    await this.handleBuildSandbox(command, image);

    // Build docker run args (extracted from sandbox.ts:302-704)
    const args = await this.buildRunArgs(
      context,
      command,
      image,
      workdir,
      containerWorkdir,
    );

    // Handle proxy (extracted from sandbox.ts:706-776)
    const proxyCommand = process.env['GEMINI_SANDBOX_PROXY_COMMAND'];
    let proxyProcess: ChildProcess | undefined;
    let sandboxProcess: ChildProcess | undefined;

    try {
      if (proxyCommand) {
        proxyProcess = await this.startProxyContainer(
          command,
          proxyCommand,
          image,
          workdir,
        );
      }

      // Spawn container (extracted from sandbox.ts:778-799)
      process.stdin.pause();
      sandboxProcess = spawn(command, args, {
        stdio: 'inherit',
      });

      return await new Promise<number>((resolve, reject) => {
        sandboxProcess!.on('error', (err) => {
          coreEvents.emitFeedback('error', 'Sandbox process error', err);
          reject(err);
        });

        sandboxProcess!.on('close', (code, signal) => {
          process.stdin.resume();
          if (code !== 0 && code !== null) {
            debugLogger.log(
              `Sandbox process exited with code: ${code}, signal: ${signal}`,
            );
          }
          resolve(code ?? 1);
        });
      });
    } finally {
      // Cleanup proxy container if it was started
      if (proxyProcess) {
        try {
          execSync(`${command} rm -f ${SANDBOX_PROXY_NAME}`, {
            stdio: 'ignore',
          });
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  // --- Private Methods ---

  private async handleBuildSandbox(
    command: string,
    image: string,
  ): Promise<void> {
    // Extracted from sandbox.ts:259-289
    if (!process.env['BUILD_SANDBOX']) return;

    const gcPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';

    if (!gcPath.includes('gemini-cli/packages/')) {
      throw new FatalSandboxError(
        'Cannot build sandbox using installed gemini binary; ' +
          'run `npm link ./packages/cli` under gemini-cli repo to switch to linked binary.',
      );
    }

    debugLogger.log('building sandbox ...');
    const gcRoot = gcPath.split('/packages/')[0];
    const projectSandboxDockerfile = path.join(
      GEMINI_DIR,
      'sandbox.Dockerfile',
    );
    let buildArgs = '';
    if (fs.existsSync(projectSandboxDockerfile)) {
      debugLogger.log(`using ${projectSandboxDockerfile} for sandbox`);
      buildArgs += `-f ${path.resolve(projectSandboxDockerfile)} -i ${image}`;
    }
    execSync(`cd ${gcRoot} && node scripts/build_sandbox.js -s ${buildArgs}`, {
      stdio: 'inherit',
      env: {
        ...process.env,
        GEMINI_SANDBOX: command,
      },
    });
  }

  private async buildRunArgs(
    context: SandboxDriverContext,
    command: string,
    image: string,
    workdir: string,
    containerWorkdir: string,
  ): Promise<string[]> {
    // Extracted from sandbox.ts:302-704
    const args = ['run', '-i', '--rm', '--init', '--workdir', containerWorkdir];

    // Add runsc runtime if using gVisor (sandbox.ts:307-309)
    if (this.runtime === 'runsc') {
      args.push('--runtime=runsc');
    }

    // Custom flags from SANDBOX_FLAGS (sandbox.ts:311-318)
    if (process.env['SANDBOX_FLAGS']) {
      const flags = parse(process.env['SANDBOX_FLAGS'], process.env).filter(
        (f): f is string => typeof f === 'string',
      );
      args.push(...flags);
    }

    // TTY (sandbox.ts:320-323)
    if (process.stdin.isTTY) {
      args.push('-t');
    }

    // host.docker.internal (sandbox.ts:325-326)
    args.push('--add-host', 'host.docker.internal:host-gateway');

    // Volume mounts (sandbox.ts:328-365)
    args.push('--volume', `${workdir}:${containerWorkdir}`);

    const userHomeDirOnHost = homedir();
    const userSettingsDirInSandbox = getContainerPath(
      `/home/node/${GEMINI_DIR}`,
    );
    if (!fs.existsSync(userHomeDirOnHost)) {
      fs.mkdirSync(userHomeDirOnHost, { recursive: true });
    }
    const userSettingsDirOnHost = path.join(userHomeDirOnHost, GEMINI_DIR);
    if (!fs.existsSync(userSettingsDirOnHost)) {
      fs.mkdirSync(userSettingsDirOnHost, { recursive: true });
    }

    args.push(
      '--volume',
      `${userSettingsDirOnHost}:${userSettingsDirInSandbox}`,
    );
    if (userSettingsDirInSandbox !== getContainerPath(userSettingsDirOnHost)) {
      args.push(
        '--volume',
        `${userSettingsDirOnHost}:${getContainerPath(userSettingsDirOnHost)}`,
      );
    }

    // Mount tmpdir (sandbox.ts:356-357)
    args.push('--volume', `${os.tmpdir()}:${getContainerPath(os.tmpdir())}`);

    // Mount homedir (sandbox.ts:359-365)
    if (userHomeDirOnHost !== os.homedir()) {
      args.push(
        '--volume',
        `${userHomeDirOnHost}:${getContainerPath(userHomeDirOnHost)}`,
      );
    }

    // gcloud config (sandbox.ts:367-374)
    const gcloudConfigDir = path.join(homedir(), '.config', 'gcloud');
    if (fs.existsSync(gcloudConfigDir)) {
      args.push(
        '--volume',
        `${gcloudConfigDir}:${getContainerPath(gcloudConfigDir)}:ro`,
      );
    }

    // ADC file (sandbox.ts:376-386)
    if (process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
      const adcFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      if (fs.existsSync(adcFile)) {
        args.push('--volume', `${adcFile}:${getContainerPath(adcFile)}:ro`);
        args.push(
          '--env',
          `GOOGLE_APPLICATION_CREDENTIALS=${getContainerPath(adcFile)}`,
        );
      }
    }

    // SANDBOX_MOUNTS (sandbox.ts:388-413)
    if (process.env['SANDBOX_MOUNTS']) {
      for (let mount of process.env['SANDBOX_MOUNTS'].split(',')) {
        if (mount.trim()) {
          let [from, to, opts] = mount.trim().split(':');
          to = to || from;
          opts = opts || 'ro';
          mount = `${from}:${to}:${opts}`;
          if (!path.isAbsolute(from)) {
            throw new FatalSandboxError(
              `Path '${from}' listed in SANDBOX_MOUNTS must be absolute`,
            );
          }
          if (!fs.existsSync(from)) {
            throw new FatalSandboxError(
              `Missing mount path '${from}' listed in SANDBOX_MOUNTS`,
            );
          }
          debugLogger.log(`SANDBOX_MOUNTS: ${from} -> ${to} (${opts})`);
          args.push('--volume', mount);
        }
      }
    }

    // config.allowedPaths (sandbox.ts:415-426)
    if (context.config.allowedPaths) {
      for (const hostPath of context.config.allowedPaths) {
        if (hostPath && path.isAbsolute(hostPath) && fs.existsSync(hostPath)) {
          const containerPath = getContainerPath(hostPath);
          debugLogger.log(
            `Config allowedPath: ${hostPath} -> ${containerPath} (ro)`,
          );
          args.push('--volume', `${hostPath}:${containerPath}:ro`);
        }
      }
    }

    // Ports (sandbox.ts:428-435)
    ports().forEach((p) => args.push('--publish', `${p}:${p}`));

    if (process.env['DEBUG']) {
      const debugPort = process.env['DEBUG_PORT'] || '9229';
      args.push(`--publish`, `${debugPort}:${debugPort}`);
    }

    // Proxy env vars (sandbox.ts:437-461)
    const proxyCommand = process.env['GEMINI_SANDBOX_PROXY_COMMAND'];
    if (proxyCommand) {
      let proxy =
        process.env['HTTPS_PROXY'] ||
        process.env['https_proxy'] ||
        process.env['HTTP_PROXY'] ||
        process.env['http_proxy'] ||
        'http://localhost:8877';
      proxy = proxy.replace('localhost', SANDBOX_PROXY_NAME);
      if (proxy) {
        args.push('--env', `HTTPS_PROXY=${proxy}`);
        args.push('--env', `https_proxy=${proxy}`);
        args.push('--env', `HTTP_PROXY=${proxy}`);
        args.push('--env', `http_proxy=${proxy}`);
      }
      const noProxy = process.env['NO_PROXY'] || process.env['no_proxy'];
      if (noProxy) {
        args.push('--env', `NO_PROXY=${noProxy}`);
        args.push('--env', `no_proxy=${noProxy}`);
      }
    }

    // Network (sandbox.ts:463-483)
    if (!context.config.networkAccess || proxyCommand) {
      const isInternal = !context.config.networkAccess || !!proxyCommand;
      const networkFlags = isInternal ? '--internal' : '';

      execSync(
        `${command} network inspect ${SANDBOX_NETWORK_NAME} || ${command} network create ${networkFlags} ${SANDBOX_NETWORK_NAME}`,
        { stdio: 'ignore' },
      );
      args.push('--network', SANDBOX_NETWORK_NAME);

      if (proxyCommand) {
        execSync(
          `${command} network inspect ${SANDBOX_PROXY_NAME} || ${command} network create ${SANDBOX_PROXY_NAME}`,
          { stdio: 'ignore' },
        );
      }
    }

    // Container name (sandbox.ts:485-506)
    const imageName = parseImageName(image);
    const isIntegrationTest =
      process.env['GEMINI_CLI_INTEGRATION_TEST'] === 'true';
    let containerName;
    if (isIntegrationTest) {
      containerName = `gemini-cli-integration-test-${randomBytes(4).toString('hex')}`;
      debugLogger.log(`ContainerName: ${containerName}`);
    } else {
      let index = 0;
      const containerNameCheck = (
        await execAsync(`${command} ps -a --format "{{.Names}}"`)
      ).stdout.trim();
      while (containerNameCheck.includes(`${imageName}-${index}`)) {
        index++;
      }
      containerName = `${imageName}-${index}`;
      debugLogger.log(`ContainerName (regular): ${containerName}`);
    }
    args.push('--name', containerName, '--hostname', containerName);

    // Environment variables (sandbox.ts:508-643)
    this.addEnvironmentVars(args, containerName, context, workdir);

    // Node options (sandbox.ts:633-642)
    const existingNodeOptions = process.env['NODE_OPTIONS'] || '';
    const allNodeOptions = [
      ...(existingNodeOptions ? [existingNodeOptions] : []),
      ...context.nodeArgs,
    ].join(' ');
    if (allNodeOptions.length > 0) {
      args.push('--env', `NODE_OPTIONS="${allNodeOptions}"`);
    }

    // SANDBOX env var (sandbox.ts:644-645)
    args.push('--env', `SANDBOX=${containerName}`);

    // Podman auth file (sandbox.ts:647-652)
    if (command === 'podman') {
      const emptyAuthFilePath = path.join(os.tmpdir(), 'empty_auth.json');
      fs.writeFileSync(emptyAuthFilePath, '{}', 'utf-8');
      args.push('--authfile', emptyAuthFilePath);
    }

    // User mapping (sandbox.ts:654-698)
    const finalEntrypoint = entrypoint(workdir, context.cliArgs);

    if (process.env['GEMINI_CLI_INTEGRATION_TEST'] === 'true') {
      args.push('--user', 'root');
    } else if (await shouldUseCurrentUserInSandbox()) {
      args.push('--user', 'root');

      const uid = (await execAsync('id -u')).stdout.trim();
      const gid = (await execAsync('id -g')).stdout.trim();

      const username = 'gemini';
      const homeDir = getContainerPath(homedir());

      const setupUserCommands = [
        `groupadd -f -g ${gid} ${username}`,
        `id -u ${username} &>/dev/null || useradd -o -u ${uid} -g ${gid} -d ${homeDir} -s /bin/bash ${username}`,
      ].join(' && ');

      const originalCommand = finalEntrypoint[2];
      const escapedOriginalCommand = originalCommand.replace(/'/g, "'\\''");
      const suCommand = `su -p ${username} -c '${escapedOriginalCommand}'`;
      finalEntrypoint[2] = `${setupUserCommands} && ${suCommand}`;

      args.push('--env', `HOME=${homedir()}`);
    }

    // Image + entrypoint (sandbox.ts:700-704)
    args.push(image);
    args.push(...finalEntrypoint);

    return args;
  }

  private addEnvironmentVars(
    args: string[],
    containerName: string,
    context: SandboxDriverContext,
    workdir: string,
  ): void {
    // Extracted from sandbox.ts:508-631

    // Test var (sandbox.ts:508-514)
    if (process.env['GEMINI_CLI_TEST_VAR']) {
      args.push(
        '--env',
        `GEMINI_CLI_TEST_VAR=${process.env['GEMINI_CLI_TEST_VAR']}`,
      );
    }

    // API keys (sandbox.ts:516-522)
    if (process.env['GEMINI_API_KEY']) {
      args.push('--env', `GEMINI_API_KEY=${process.env['GEMINI_API_KEY']}`);
    }
    if (process.env['GOOGLE_API_KEY']) {
      args.push('--env', `GOOGLE_API_KEY=${process.env['GOOGLE_API_KEY']}`);
    }

    // Base URLs (sandbox.ts:524-536)
    if (process.env['GOOGLE_GEMINI_BASE_URL']) {
      args.push(
        '--env',
        `GOOGLE_GEMINI_BASE_URL=${process.env['GOOGLE_GEMINI_BASE_URL']}`,
      );
    }
    if (process.env['GOOGLE_VERTEX_BASE_URL']) {
      args.push(
        '--env',
        `GOOGLE_VERTEX_BASE_URL=${process.env['GOOGLE_VERTEX_BASE_URL']}`,
      );
    }

    // Vertex AI flags (sandbox.ts:538-552)
    if (process.env['GOOGLE_GENAI_USE_VERTEXAI']) {
      args.push(
        '--env',
        `GOOGLE_GENAI_USE_VERTEXAI=${process.env['GOOGLE_GENAI_USE_VERTEXAI']}`,
      );
    }
    if (process.env['GOOGLE_GENAI_USE_GCA']) {
      args.push(
        '--env',
        `GOOGLE_GENAI_USE_GCA=${process.env['GOOGLE_GENAI_USE_GCA']}`,
      );
    }

    // Cloud project/location (sandbox.ts:554-568)
    if (process.env['GOOGLE_CLOUD_PROJECT']) {
      args.push(
        '--env',
        `GOOGLE_CLOUD_PROJECT=${process.env['GOOGLE_CLOUD_PROJECT']}`,
      );
    }
    if (process.env['GOOGLE_CLOUD_LOCATION']) {
      args.push(
        '--env',
        `GOOGLE_CLOUD_LOCATION=${process.env['GOOGLE_CLOUD_LOCATION']}`,
      );
    }

    // Model (sandbox.ts:570-573)
    if (process.env['GEMINI_MODEL']) {
      args.push('--env', `GEMINI_MODEL=${process.env['GEMINI_MODEL']}`);
    }

    // Terminal (sandbox.ts:575-581)
    if (process.env['TERM']) {
      args.push('--env', `TERM=${process.env['TERM']}`);
    }
    if (process.env['COLORTERM']) {
      args.push('--env', `COLORTERM=${process.env['COLORTERM']}`);
    }

    // IDE vars (sandbox.ts:583-592)
    for (const envVar of [
      'GEMINI_CLI_IDE_SERVER_PORT',
      'GEMINI_CLI_IDE_WORKSPACE_PATH',
      'TERM_PROGRAM',
    ]) {
      if (process.env[envVar]) {
        args.push('--env', `${envVar}=${process.env[envVar]}`);
      }
    }

    // VIRTUAL_ENV (sandbox.ts:594-615)
    if (
      process.env['VIRTUAL_ENV']
        ?.toLowerCase()
        .startsWith(workdir.toLowerCase())
    ) {
      const sandboxVenvPath = path.resolve(GEMINI_DIR, 'sandbox.venv');
      if (!fs.existsSync(sandboxVenvPath)) {
        fs.mkdirSync(sandboxVenvPath, { recursive: true });
      }
      args.push(
        '--volume',
        `${sandboxVenvPath}:${getContainerPath(process.env['VIRTUAL_ENV'])}`,
      );
      args.push(
        '--env',
        `VIRTUAL_ENV=${getContainerPath(process.env['VIRTUAL_ENV'])}`,
      );
    }

    // SANDBOX_ENV (sandbox.ts:617-631)
    if (process.env['SANDBOX_ENV']) {
      for (let env of process.env['SANDBOX_ENV'].split(',')) {
        if ((env = env.trim())) {
          if (env.includes('=')) {
            debugLogger.log(`SANDBOX_ENV: ${env}`);
            args.push('--env', env);
          } else {
            throw new FatalSandboxError(
              'SANDBOX_ENV must be a comma-separated list of key=value pairs',
            );
          }
        }
      }
    }
  }

  private async startProxyContainer(
    command: string,
    proxyCommand: string,
    image: string,
    workdir: string,
  ): Promise<ChildProcess> {
    // Extracted from sandbox.ts:710-776

    // Determine user flag for proxy container
    let userFlag = '';
    if (process.env['GEMINI_CLI_INTEGRATION_TEST'] === 'true') {
      userFlag = '--user root';
    } else if (await shouldUseCurrentUserInSandbox()) {
      const uid = (await execAsync('id -u')).stdout.trim();
      const gid = (await execAsync('id -g')).stdout.trim();
      userFlag = `--user ${uid}:${gid}`;
    }

    const proxyContainerArgs = [
      'run',
      '--rm',
      '--init',
      ...(userFlag ? userFlag.split(' ') : []),
      '--name',
      SANDBOX_PROXY_NAME,
      '--network',
      SANDBOX_PROXY_NAME,
      '-p',
      '8877:8877',
      '-v',
      `${process.cwd()}:${workdir}`,
      '--workdir',
      workdir,
      image,
      ...parse(proxyCommand, process.env).filter(
        (f): f is string => typeof f === 'string',
      ),
    ];

    const proxyProcess = spawn(command, proxyContainerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    proxyProcess.stderr?.on('data', (data: Buffer) => {
      debugLogger.debug(`[PROXY STDERR]: ${data.toString().trim()}`);
    });

    proxyProcess.on('close', (code, signal) => {
      throw new FatalSandboxError(
        `Proxy container command '${command} ${proxyContainerArgs.join(' ')}' exited with code ${code}, signal ${signal}`,
      );
    });

    debugLogger.log('waiting for proxy to start ...');
    await execAsync(
      `until timeout 0.25 curl -s http://localhost:8877; do sleep 0.25; done`,
    );

    // Connect proxy to sandbox network (sandbox.ts:771-775)
    await execAsync(
      `${command} network connect ${SANDBOX_NETWORK_NAME} ${SANDBOX_PROXY_NAME}`,
    );

    return proxyProcess;
  }

  // --- Image Management (extracted from sandbox.ts:1052-1191) ---

  private async imageExists(image: string): Promise<boolean> {
    return new Promise((resolve) => {
      const args = ['images', '-q', image];
      const checkProcess = spawn(this.command, args);

      let stdoutData = '';
      if (checkProcess.stdout) {
        checkProcess.stdout.on('data', (data) => {
          stdoutData += data.toString();
        });
      }

      checkProcess.on('error', (err) => {
        debugLogger.warn(
          `Failed to start '${this.command}' command for image check: ${err.message}`,
        );
        resolve(false);
      });

      checkProcess.on('close', () => {
        resolve(stdoutData.trim() !== '');
      });
    });
  }

  private async pullImage(image: string): Promise<boolean> {
    debugLogger.debug(
      `Attempting to pull image ${image} using ${this.command}...`,
    );
    return new Promise((resolve) => {
      const args = ['pull', image];
      const pullProcess = spawn(this.command, args, { stdio: 'pipe' });

      const onStdoutData = (data: Buffer) => {
        if (process.env['DEBUG']) {
          debugLogger.log(data.toString().trim());
        }
      };

      const onStderrData = (data: Buffer) => {
        stderrData += data.toString();
        // eslint-disable-next-line no-console
        console.error(data.toString().trim());
      };

      const onError = (err: Error) => {
        debugLogger.warn(
          `Failed to start '${this.command} pull ${image}' command: ${err.message}`,
        );
        cleanup();
        resolve(false);
      };

      const onClose = (code: number | null) => {
        if (code === 0) {
          debugLogger.log(`Successfully pulled image ${image}.`);
          cleanup();
          resolve(true);
        } else {
          debugLogger.warn(
            `Failed to pull image ${image}. '${this.command} pull ${image}' exited with code ${code}.`,
          );
          cleanup();
          resolve(false);
        }
      };

      const cleanup = () => {
        if (pullProcess.stdout) {
          pullProcess.stdout.removeListener('data', onStdoutData);
        }
        if (pullProcess.stderr) {
          pullProcess.stderr.removeListener('data', onStderrData);
        }
        pullProcess.removeListener('error', onError);
        pullProcess.removeListener('close', onClose);
        if (pullProcess.connected) {
          pullProcess.disconnect();
        }
      };

      if (pullProcess.stdout) {
        pullProcess.stdout.on('data', onStdoutData);
      }
      if (pullProcess.stderr) {
        pullProcess.stderr.on('data', onStderrData);
      }
      pullProcess.on('error', onError);
      pullProcess.on('close', onClose);
    });
  }

  private async ensureSandboxImageIsPresent(image: string): Promise<boolean> {
    debugLogger.log(`Checking for sandbox image: ${image}`);
    if (await this.imageExists(image)) {
      debugLogger.log(`Sandbox image ${image} found locally.`);
      return true;
    }

    debugLogger.log(`Sandbox image ${image} not found locally.`);
    if (image === LOCAL_DEV_SANDBOX_IMAGE_NAME) {
      return false;
    }

    if (await this.pullImage(image)) {
      if (await this.imageExists(image)) {
        debugLogger.log(
          `Sandbox image ${image} is now available after pulling.`,
        );
        return true;
      } else {
        debugLogger.warn(
          `Sandbox image ${image} still not found after a pull attempt.`,
        );
        return false;
      }
    }

    coreEvents.emitFeedback(
      'error',
      `Failed to obtain sandbox image ${image} after check and pull attempt.`,
    );
    return false;
  }
}

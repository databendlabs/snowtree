import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ShellDetector } from './shellDetector';
import { fileLogger } from '../logging/fileLogger';

// Try to import app from electron (might not be available in all contexts)
let app: typeof import('electron').app | undefined;
try {
  app = require('electron').app;
} catch {
  // Electron not available (e.g., in worker threads)
  app = undefined;
}

// Try to get config manager for additional paths
let getAdditionalPaths: () => string[] = () => [];
try {
  // Lazy import to avoid circular dependencies
  const getConfigManager = () => {
    try {
      const { configManager } = require('../services/configManager');
      return configManager;
    } catch {
      return null;
    }
  };
  
  getAdditionalPaths = () => {
    const configManager = getConfigManager();
    if (configManager) {
      const config = configManager.getConfig();
      return config?.additionalPaths || [];
    }
    return [];
  };
} catch {
  // ConfigManager not available
}

let cachedPath: string | null = null;
let isFirstCall: boolean = true;

/**
 * Get the path separator for the current platform
 */
function getPathSeparator(): string {
  return process.platform === 'win32' ? ';' : ':';
}

/**
 * Get the user's shell PATH by executing their shell
 */
export function getShellPath(): string {
  // In packaged apps, always refresh PATH on first call to avoid cached restricted PATH
  if (cachedPath && !isFirstCall) {
    return cachedPath;
  }
  isFirstCall = false;

  fileLogger.info('ShellPath', 'Starting PATH detection', {
    platform: process.platform,
    shell: process.env.SHELL || 'not set',
    home: os.homedir()
  });

  const isWindows = process.platform === 'win32';
  const pathSep = getPathSeparator();
  const essentialPaths = isWindows
    ? []
    : ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'];

  try {
    let shellPath: string;
    
    if (isWindows) {
      // On Windows, use cmd.exe to get PATH
      shellPath = execSync('echo %PATH%', {
        encoding: 'utf8',
        timeout: 5000,
        shell: 'cmd.exe'
      }).trim();
      
      // Also try to get PATH from PowerShell for more complete results
      try {
        const psPath = execSync('powershell -Command "$env:PATH"', {
          encoding: 'utf8',
          timeout: 5000
        }).trim();
        
        if (psPath) {
          // Combine both paths
          const combinedPaths = new Set([
            ...shellPath.split(pathSep),
            ...psPath.split(pathSep)
          ]);
          shellPath = Array.from(combinedPaths).filter(p => p).join(pathSep);
        }
      } catch {
        // PowerShell might not be available, continue with cmd.exe result
      }
    } else {
      // Unix/macOS logic - use ShellDetector to get the actual shell
      const shellInfo = ShellDetector.getDefaultShell();
      const shell = shellInfo.path;
      const isLinux = process.platform === 'linux';

      fileLogger.debug('ShellPath', 'Detected shell', { shell, name: shellInfo.name, isLinux });

      // For Linux, avoid slow interactive shell startup
      // Use non-interactive mode for better performance
      const shellCommand = isLinux
        ? `${shell} -c 'echo $PATH'`  // Fast non-interactive mode for Linux
        : `${shell} -l -i -c 'echo $PATH'`;  // Keep login shell for macOS
      
      // Execute the command to get the PATH
      // For packaged apps, ALWAYS use login shell to get the user's real PATH
      const isPackaged = process.env.NODE_ENV === 'production' || 'pkg' in process || app?.isPackaged;
      
      if (isPackaged) {
        // Use minimal base PATH - just enough to find the shell
        const minimalPath = '/usr/bin:/bin';
        
        // Use login shell to load user's full environment
        try {
          // First try with explicit sourcing of shell config files
          let sourceCommand = '';
          const homeDir = os.homedir();
          
          if (shell.includes('zsh')) {
            // For zsh, source the standard config files
            sourceCommand = `source /etc/zprofile 2>/dev/null || true; ` +
                           `source ${homeDir}/.zprofile 2>/dev/null || true; ` +
                           `source /etc/zshrc 2>/dev/null || true; ` +
                           `source ${homeDir}/.zshrc 2>/dev/null || true; `;
          } else if (shell.includes('bash')) {
            // For bash, source the standard config files
            sourceCommand = `source /etc/profile 2>/dev/null || true; ` +
                           `source ${homeDir}/.bash_profile 2>/dev/null || true; ` +
                           `source ${homeDir}/.bashrc 2>/dev/null || true; `;
          }
          
          const fullCommand = `${shell} -c '${sourceCommand}echo $PATH'`;

          shellPath = execSync(fullCommand, {
            encoding: 'utf8',
            timeout: isLinux ? 3000 : 10000,  // Shorter timeout for Linux
            env: {
              PATH: minimalPath,
              SHELL: shell,
              USER: os.userInfo().username,
              HOME: homeDir,
              // Add ZDOTDIR for zsh users who might have custom config location
              ZDOTDIR: process.env.ZDOTDIR || homeDir
            }
          }).trim();
          fileLogger.debug('ShellPath', 'Loaded PATH from shell config', { method: 'source' });
        } catch {
          // Try the standard login shell approach
          try {
            shellPath = execSync(shellCommand, {
              encoding: 'utf8',
              timeout: isLinux ? 3000 : 10000,  // Shorter timeout for Linux
              env: {
                PATH: '/usr/bin:/bin',
                SHELL: shell,
                USER: os.userInfo().username,
                HOME: os.homedir()
              }
            }).trim();
            fileLogger.debug('ShellPath', 'Loaded PATH from login shell', { method: 'login' });
          } catch {
            // Fallback to current PATH + common locations
            shellPath = process.env.PATH || '';
            fileLogger.debug('ShellPath', 'Using fallback PATH', { method: 'env' });
          }
        }
      } else {
        // In development, try faster approach first
        try {
          shellPath = execSync(`${shell} -c 'echo $PATH'`, {
            encoding: 'utf8',
            timeout: 2000,
            env: process.env
          }).trim();
        } catch {
          shellPath = execSync(shellCommand, {
            encoding: 'utf8',
            timeout: isLinux ? 3000 : 10000,  // Shorter timeout for Linux
            env: process.env
          }).trim();
        }
      }
    }

    // Combine with current process PATH to ensure we don't lose anything
    const currentPath = process.env.PATH || '';
    
    // Also include npm global bin directories
    const additionalPaths: string[] = [];
    const isLinux = process.platform === 'linux';
    
    // Skip npm/yarn checks on Linux for better performance (they're usually in PATH already)
    if (!isLinux) {
      // Try to get npm global bin directory
      try {
        const npmBin = execSync('npm bin -g', { 
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (npmBin) additionalPaths.push(npmBin);
      } catch {
        // Ignore npm bin errors
      }
      
      // Try to get yarn global bin directory
      try {
        const yarnBin = execSync('yarn global bin', { 
          encoding: 'utf8',
          timeout: 2000,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        if (yarnBin) additionalPaths.push(yarnBin);
      } catch {
        // Ignore yarn bin errors
      }
    }
    
    if (isWindows) {
      // Windows-specific paths
      additionalPaths.push(
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
        path.join(os.homedir(), 'AppData', 'Local', 'Yarn', 'bin'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'bin'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Git', 'cmd'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'bin'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd')
      );
      
      // Check for nvm-windows
      const nvmHome = process.env.NVM_HOME;
      if (nvmHome && fs.existsSync(nvmHome)) {
        additionalPaths.push(nvmHome);
      }
      
      // Check for nvm-windows symlink
      const nvmSymlink = process.env.NVM_SYMLINK;
      if (nvmSymlink && fs.existsSync(nvmSymlink)) {
        additionalPaths.push(nvmSymlink);
      }
    } else {
      // Unix/macOS-specific paths
      additionalPaths.push(
        path.join(os.homedir(), '.yarn', 'bin'),
        path.join(os.homedir(), '.config', 'yarn', 'global', 'node_modules', '.bin')
      );
      
      // Linux-specific common paths
      if (isLinux) {
        const commonLinuxPaths = [
          '/usr/local/bin',
          '/snap/bin',
          path.join(os.homedir(), '.local', 'bin'),
          path.join(os.homedir(), 'bin'),
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin'
        ];
        
        // Only add Linux paths that exist and aren't already in PATH
        const existingPaths = new Set([...shellPath.split(pathSep), ...currentPath.split(pathSep)]);
        commonLinuxPaths.forEach(linuxPath => {
          if (!existingPaths.has(linuxPath) && fs.existsSync(linuxPath)) {
            additionalPaths.push(linuxPath);
          }
        });
      }
      
      // Check for nvm directories - look for all versions
      const nvmDir = path.join(os.homedir(), '.nvm/versions/node');
      if (fs.existsSync(nvmDir)) {
        try {
          const versions = fs.readdirSync(nvmDir);
          versions.forEach(version => {
            const binPath = path.join(nvmDir, version, 'bin');
            if (fs.existsSync(binPath)) {
              additionalPaths.push(binPath);
            }
          });
        } catch {
          // Ignore nvm directory read errors
        }
      }
    }
    
    // Add user-configured additional paths
    const userAdditionalPaths = getAdditionalPaths();
    if (userAdditionalPaths.length > 0) {
      // Expand ~ to home directory and Windows environment variables
      const expandedUserPaths = userAdditionalPaths.map(p => {
        // Expand tilde for Unix/macOS
        if (p.startsWith('~')) {
          return path.join(os.homedir(), p.slice(1));
        }
        
        // Expand Windows environment variables like %USERPROFILE%
        if (isWindows && p.includes('%')) {
          return p.replace(/%([^%]+)%/g, (match, envVar) => {
            return process.env[envVar] || match;
          });
        }
        
        return p;
      });
      additionalPaths.push(...expandedUserPaths);
    }
    
    const combinedPaths = new Set([
      ...shellPath.split(pathSep),
      ...currentPath.split(pathSep),
      ...additionalPaths,
      ...essentialPaths
    ]);
    
    cachedPath = Array.from(combinedPaths).filter(p => p).join(pathSep);
    const pathEntries = cachedPath.split(pathSep);

    fileLogger.info('ShellPath', 'PATH loaded successfully', {
      entries: pathEntries.length,
      additionalPaths: additionalPaths.length,
      sample: pathEntries.slice(0, 5)
    });

    return cachedPath;
  } catch (error) {
    fileLogger.error('ShellPath', 'Failed to get shell PATH', error instanceof Error ? error : undefined);
    
    if (!isWindows) {
      // Try alternative method: read shell config files directly (Unix/macOS only)
      try {
        const homeDir = os.homedir();
        const shellConfigPaths = [
          path.join(homeDir, '.zshrc'),
          path.join(homeDir, '.bashrc'),
          path.join(homeDir, '.bash_profile'),
          path.join(homeDir, '.profile'),
          path.join(homeDir, '.zprofile')
        ];

        const extractedPaths: string[] = [];

        for (const configPath of shellConfigPaths) {
          if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf8');
            // Look for PATH exports
            const pathMatches = content.match(/export\s+PATH=["']?([^"'\n]+)["']?/gm);
            if (pathMatches) {
              pathMatches.forEach(match => {
                const pathValue = match.replace(/export\s+PATH=["']?/, '').replace(/["']?$/, '');
                // Expand $PATH references
                if (pathValue.includes('$PATH')) {
                  extractedPaths.push(pathValue.replace(/\$PATH/g, process.env.PATH || ''));
                } else {
                  extractedPaths.push(pathValue);
                }
              });
            }
          }
        }

        if (extractedPaths.length > 0) {
          const combinedPaths = new Set(extractedPaths.join(pathSep).split(pathSep).filter(p => p));
          cachedPath = Array.from(combinedPaths).join(pathSep);
          fileLogger.info('ShellPath', 'Loaded PATH from config files', { entries: cachedPath.split(pathSep).length });
          return cachedPath;
        }
      } catch {
        // Continue to final fallback
      }
    }

    // Final fallback to process PATH
    const fallbackPath = isWindows
      ? process.env.PATH || 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem'
      : process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';

    fileLogger.error('ShellPath', 'Using fallback PATH', undefined);
    return fallbackPath;
  }
}

/**
 * Clear the cached PATH (useful for development/testing and config changes)
 */
export function clearShellPathCache(): void {
  cachedPath = null;
  fileLogger.state('ShellPath', 'PATH cache cleared');
}

/**
 * Find an executable in the shell PATH
 */
export function findExecutableInPath(executable: string): string | null {
  const shellPath = getShellPath();
  const pathSep = getPathSeparator();
  const paths = shellPath.split(pathSep);
  const isWindows = process.platform === 'win32';

  // On Windows, executables might have .exe, .cmd, or .bat extensions
  const executableNames = isWindows
    ? [executable, `${executable}.exe`, `${executable}.cmd`, `${executable}.bat`]
    : [executable];

  for (const dir of paths) {
    for (const execName of executableNames) {
      const fullPath = path.join(dir, execName);
      try {
        if (isWindows) {
          // On Windows, check if file exists
          fs.accessSync(fullPath, fs.constants.F_OK);
          fileLogger.debug('ShellPath', `Found executable: ${executable}`, { path: fullPath });
          return fullPath;
        } else {
          // On Unix, check if the executable exists and is executable
          execSync(`test -x "${fullPath}"`, { stdio: 'ignore' });
          fileLogger.debug('ShellPath', `Found executable: ${executable}`, { path: fullPath });
          return fullPath;
        }
      } catch {
        // Not found in this directory
      }
    }
  }

  fileLogger.error('ShellPath', `Executable not found: ${executable}`);
  return null;
}

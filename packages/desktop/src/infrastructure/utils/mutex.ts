import { Logger } from '../logging/logger';

// Use console logging for mutex operations since logger might not be available
const logger = {
  debug: (msg: string) => console.log(`[Mutex] ${msg}`),
  warn: (msg: string) => console.warn(`[Mutex] ${msg}`)
};

/**
 * A simple async mutex implementation for preventing race conditions
 * in critical sections of code. Supports named locks and timeouts.
 */
export class Mutex {
  private queue = new Map<string, Array<() => void>>();
  private locked = new Set<string>();
  private defaultTimeout = 30000; // 30 seconds

  async acquire(resourceName: string, timeout: number = this.defaultTimeout): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove from queue on timeout
        const waiters = this.queue.get(resourceName);
        if (waiters) {
          const idx = waiters.indexOf(tryAcquire);
          if (idx !== -1) waiters.splice(idx, 1);
        }
        reject(new Error(`Mutex timeout after ${timeout}ms waiting for lock: ${resourceName}`));
      }, timeout);

      const tryAcquire = () => {
        clearTimeout(timer);
        this.locked.add(resourceName);
        resolve(() => {
          this.locked.delete(resourceName);
          const waiters = this.queue.get(resourceName);
          if (waiters && waiters.length > 0) {
            const next = waiters.shift()!;
            if (waiters.length === 0) this.queue.delete(resourceName);
            next();
          }
        });
      };

      if (!this.locked.has(resourceName)) {
        tryAcquire();
      } else {
        if (!this.queue.has(resourceName)) this.queue.set(resourceName, []);
        this.queue.get(resourceName)!.push(tryAcquire);
      }
    });
  }

  /**
   * Execute a function with a mutex lock
   * @param resourceName - Unique name for the resource to lock
   * @param fn - Function to execute while holding the lock
   * @param timeout - Optional timeout in milliseconds
   * @returns Promise<T> - Result of the function execution
   */
  async withLock<T>(
    resourceName: string, 
    fn: () => Promise<T> | T, 
    timeout?: number
  ): Promise<T> {
    const release = await this.acquire(resourceName, timeout);
    
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if a resource is currently locked
   * @param resourceName - Name of the resource to check
   * @returns boolean - True if the resource is locked
   */
  isLocked(resourceName: string): boolean {
    return this.locked.has(resourceName);
  }

  getActiveLockCount(): number {
    return this.locked.size;
  }

  getLockedResources(): string[] {
    return Array.from(this.locked);
  }

  releaseAll(): void {
    logger.warn(`[Mutex] Force releasing all locks (${this.locked.size} active locks)`);
    this.locked.clear();
    this.queue.clear();
  }
}

// Global mutex instance for the application
export const mutex = new Mutex();

/**
 * Convenience function to execute code with a named lock
 * @param resourceName - Unique name for the resource to lock
 * @param fn - Function to execute while holding the lock
 * @param timeout - Optional timeout in milliseconds
 * @returns Promise<T> - Result of the function execution
 */
export async function withLock<T>(
  resourceName: string, 
  fn: () => Promise<T> | T, 
  timeout?: number
): Promise<T> {
  return mutex.withLock(resourceName, fn, timeout);
}

/**
 * Convenience function to acquire a named lock
 * @param resourceName - Unique name for the resource to lock
 * @param timeout - Optional timeout in milliseconds
 * @returns Promise<() => void> - Release function to unlock the resource
 */
export async function acquireLock(resourceName: string, timeout?: number): Promise<() => void> {
  return mutex.acquire(resourceName, timeout);
}

/**
 * Check if a resource is currently locked
 * @param resourceName - Name of the resource to check
 * @returns boolean - True if the resource is locked
 */
export function isLocked(resourceName: string): boolean {
  return mutex.isLocked(resourceName);
}
export function createMutex(): Mutex {
  return new Mutex();
}

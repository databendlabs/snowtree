import * as fs from 'fs/promises';
import * as path from 'path';

export interface DiffMetadata {
  filePath: string;
  oldString: string;
  newString: string;
  isDelete?: boolean;
  isNewFile?: boolean;
}

export interface DiffExtractionContext {
  cwd: string;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB limit

/**
 * Extracts diff metadata from normalized tool entries.
 * Supports both Claude and Codex tool formats.
 */
export class DiffMetadataExtractor {
  constructor(private context: DiffExtractionContext) {}

  /**
   * Extract diff metadata from a tool entry.
   * Returns null if no diff can be extracted.
   */
  async extract(
    toolName: string,
    metadata: Record<string, unknown> | undefined
  ): Promise<DiffMetadata[] | null> {
    if (!metadata) return null;

    // Claude tools
    if (toolName === 'Edit') {
      return this.extractClaudeEdit(metadata);
    }
    if (toolName === 'Write') {
      return this.extractClaudeWrite(metadata);
    }
    if (toolName === 'Bash') {
      return this.extractClaudeBash(metadata);
    }

    // Kimi tools
    if (toolName === 'StrReplaceFile') {
      return this.extractKimiReplace(metadata);
    }
    if (toolName === 'WriteFile') {
      return this.extractKimiWrite(metadata);
    }
    if (toolName === 'Shell') {
      return this.extractKimiShell(metadata);
    }

    // Codex tools
    if (toolName === 'fileChange') {
      return this.extractCodexFileChange(metadata);
    }
    if (toolName === 'commandExecution') {
      return this.extractCodexCommand(metadata);
    }

    return null;
  }

  private async extractClaudeEdit(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const filePath = input.file_path as string | undefined;
    const oldString = input.old_string as string | undefined;
    const newString = input.new_string as string | undefined;

    if (!filePath || oldString === undefined || newString === undefined) return null;

    // For Edit tool, we should show the diff between oldString and newString
    // NOT the entire file content. The Edit tool already provides the exact
    // strings that were changed, so we use them directly.
    return [{
      filePath,
      oldString,
      newString,
    }];
  }

  private async extractClaudeWrite(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const filePath = input.file_path as string | undefined;
    const newString = input.content as string | undefined;

    if (!filePath || newString === undefined) return null;

    // Read existing content if file exists
    const oldString = await this.readFileIfExists(filePath);

    return [{
      filePath,
      oldString: oldString ?? '',
      newString,
      isNewFile: oldString === null,
    }];
  }

  private async extractClaudeBash(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const command = input.command as string | undefined;
    if (!command) return null;

    const deleteInfo = this.parseDeleteCommand(command);
    if (!deleteInfo) return null;

    const results: DiffMetadata[] = [];
    for (const filePath of deleteInfo.files) {
      const content = await this.readFileIfExists(filePath);
      if (content !== null) {
        results.push({
          filePath,
          oldString: content,
          newString: '',
          isDelete: true,
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  private async extractKimiWrite(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const filePath = (input.path || input.file_path) as string | undefined;
    const content = input.content as string | undefined;
    const mode = (input.mode as string | undefined) || 'overwrite';

    if (!filePath || content === undefined) return null;

    const oldString = await this.readFileIfExists(filePath);
    const newString = mode === 'append'
      ? `${oldString ?? ''}${content}`
      : content;

    return [{
      filePath,
      oldString: oldString ?? '',
      newString,
      isNewFile: oldString === null,
    }];
  }

  private async extractKimiReplace(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const filePath = (input.path || input.file_path) as string | undefined;
    const edit = input.edit as Record<string, unknown> | Array<Record<string, unknown>> | undefined;

    if (!filePath || !edit) return null;

    const edits = Array.isArray(edit) ? edit : [edit];
    const results: DiffMetadata[] = [];
    for (const item of edits) {
      const oldString = item.old as string | undefined;
      const newString = item.new as string | undefined;
      if (oldString === undefined || newString === undefined) continue;
      results.push({
        filePath,
        oldString,
        newString,
      });
    }

    return results.length > 0 ? results : null;
  }

  private async extractKimiShell(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const input = metadata.input as Record<string, unknown> | undefined;
    if (!input) return null;

    const command = input.command as string | undefined;
    if (!command) return null;

    const deleteInfo = this.parseDeleteCommand(command);
    if (!deleteInfo) return null;

    const results: DiffMetadata[] = [];
    for (const filePath of deleteInfo.files) {
      const content = await this.readFileIfExists(filePath);
      if (content !== null) {
        results.push({
          filePath,
          oldString: content,
          newString: '',
          isDelete: true,
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  private extractCodexFileChange(metadata: Record<string, unknown>): DiffMetadata[] | null {
    const changes = metadata.changes as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(changes) || changes.length === 0) return null;

    const results: DiffMetadata[] = [];
    for (const change of changes) {
      const filePath = change.path as string | undefined;
      // Codex API uses 'diff' field (not 'unified_diff')
      const diff = (change.diff || change.unified_diff) as string | undefined;
      const content = change.content as string | undefined;
      // Codex uses 'kind' with type field: { type: 'add' | 'delete' | 'update' }
      const kind = change.kind as { type?: string } | string | undefined;
      const kindType = typeof kind === 'string' ? kind : kind?.type;

      if (!filePath) continue;

      // If we have diff content, parse it
      if (diff) {
        const parsed = this.parseUnifiedDiff(diff);
        if (parsed) {
          results.push({
            filePath,
            ...parsed,
            isDelete: kindType === 'delete',
            isNewFile: kindType === 'add',
          });
        }
      } else if (content !== undefined) {
        // New file with full content (no diff)
        results.push({
          filePath,
          oldString: kindType === 'delete' ? content : '',
          newString: kindType === 'delete' ? '' : content,
          isNewFile: kindType === 'add',
          isDelete: kindType === 'delete',
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  private async extractCodexCommand(metadata: Record<string, unknown>): Promise<DiffMetadata[] | null> {
    const command = metadata.command as string | undefined;
    if (!command) return null;

    // Same logic as Claude Bash for rm commands
    const deleteInfo = this.parseDeleteCommand(command);
    if (!deleteInfo) return null;

    const results: DiffMetadata[] = [];
    for (const filePath of deleteInfo.files) {
      const content = await this.readFileIfExists(filePath);
      if (content !== null) {
        results.push({
          filePath,
          oldString: content,
          newString: '',
          isDelete: true,
        });
      }
    }

    return results.length > 0 ? results : null;
  }

  private parseDeleteCommand(command: string): { files: string[] } | null {
    // Match rm command patterns: rm file, rm -f file, rm -rf dir, etc.
    const rmPattern = /^rm\s+(?:-[rfivd]+\s+)*(.+)$/;
    const match = command.trim().match(rmPattern);
    if (!match) return null;

    // Parse file arguments (simple split, handles basic cases)
    const args = match[1].trim();
    const files = args.split(/\s+/).filter(f => !f.startsWith('-'));
    return files.length > 0 ? { files } : null;
  }

  private parseUnifiedDiff(diff: string): { oldString: string; newString: string } | null {
    // Parse unified diff format to extract old/new content
    const lines = diff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
        continue;
      }
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
    }

    return {
      oldString: oldLines.join('\n'),
      newString: newLines.join('\n'),
    };
  }

  private async readFileIfExists(filePath: string): Promise<string | null> {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.context.cwd, filePath);

      // Check file size first
      const stats = await fs.stat(absolutePath);
      if (stats.size > MAX_FILE_SIZE) {
        return null; // Skip large files
      }

      // Check if it's a text file (simple heuristic)
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Skip binary files (contains null bytes)
      if (content.includes('\0')) {
        return null;
      }

      return content;
    } catch {
      return null; // File doesn't exist or can't be read
    }
  }
}

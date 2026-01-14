import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Project, ProjectRunCommand, Folder, Session, SessionOutput, CreateSessionData, UpdateSessionData, ConversationMessage, PromptMarker, ExecutionDiff, CreateExecutionDiffData, CreatePanelExecutionDiffData } from './models';
import type { TimelineEvent, CreateTimelineEventData } from './models';
import type { ToolPanel, ToolPanelType, ToolPanelState, ToolPanelMetadata } from '@snowtree/core/types/panels';
import { fileLogger } from '../logging/fileLogger';

// Interface for legacy claude_panel_settings during migration
interface ClaudePanelSetting {
  id: number;
  panel_id: string;
  model?: string;
  commit_mode?: boolean;
  system_prompt?: string;
  max_tokens?: number;
  temperature?: number;
  created_at: string;
  updated_at: string;
}

// Interface for tool panel database rows
interface ToolPanelRow {
  id: string;
  session_id: string;
  type: string;
  title: string;
  state: string | null;
  metadata: string | null;
  created_at: string;
}

// Interface for execution diff database rows
interface ExecutionDiffRow {
  id: number;
  session_id: string;
  prompt_marker_id?: number;
  execution_sequence: number;
  git_diff?: string;
  files_changed?: string;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  before_commit_hash?: string;
  after_commit_hash?: string;
  commit_message?: string;
  timestamp: string;
}

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure the directory exists before creating the database
    const dir = dirname(dbPath);
    mkdirSync(dir, { recursive: true });
    
    this.db = new Database(dbPath);
  }

  /**
   * Execute a function within a database transaction with automatic rollback on error
   * @param fn Function to execute within the transaction
   * @returns Result of the function
   * @throws Error if transaction fails
   */
  private transaction<T>(fn: () => T): T {
    const transaction = this.db.transaction(() => {
      return fn();
    });
    
    return transaction();
  }

  /**
   * Execute an async function within a database transaction with automatic rollback on error
   * @param fn Async function to execute within the transaction
   * @returns Promise with result of the function
   * @throws Error if transaction fails
   */
  private async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(() => {
        fn().then(resolve).catch(reject);
      });
      
      try {
        transaction();
      } catch (error) {
        reject(error);
      }
    });
  }

  initialize(): void {
    this.initializeSchema();
    this.runMigrations();
  }

  private initializeSchema(): void {
    this.transaction(() => {
      const schemaPath = join(__dirname, 'schema.sql');
      const schema = readFileSync(schemaPath, 'utf-8');
      
      // Execute schema in parts (sqlite3 doesn't support multiple statements in exec)
      const statements = schema.split(';').filter(stmt => stmt.trim());
      for (const statement of statements) {
        if (statement.trim()) {
          this.db.prepare(statement.trim()).run();
        }
      }
    });
  }

  private runMigrations(): void {
    // Ensure migrations tracking table exists
    this.ensureMigrationsTable();

    // Define all migrations (version-based, post v1.0.34)
    interface Migration {
      version: number;
      name: string;
      run: () => void;
    }

    const migrations: Migration[] = [
      { version: 1, name: 'add_execution_mode', run: () => this.migrate_001_add_execution_mode() },
      // Future migrations go here
    ];

    // Get already applied migrations
    const appliedVersions = this.getAppliedMigrations();

    // Run pending migrations in order
    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        console.log(`[Database] Running migration ${migration.version}: ${migration.name}`);
        try {
          migration.run();
          this.recordMigration(migration.version, migration.name);
          console.log(`[Database] Completed migration ${migration.version}: ${migration.name}`);
        } catch (error) {
          console.error(`[Database] Failed migration ${migration.version}: ${migration.name}`, error);
          throw error;
        }
      }
    }

    // Final safety pass: ensure critical columns exist
    this.ensureSessionsTableColumns();
  }

  private ensureMigrationsTable(): void {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  }

  private getAppliedMigrations(): Set<number> {
    const rows = this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    return new Set(rows.map(r => r.version));
  }

  private recordMigration(version: number, name: string): void {
    this.db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(version, name);
  }

  // Migration 001: Add execution_mode column to sessions table
  private migrate_001_add_execution_mode(): void {
    interface SqliteTableInfo {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }

    const tableInfo = this.db.prepare("PRAGMA table_info(sessions)").all() as SqliteTableInfo[];
    const hasColumn = tableInfo.some((col: SqliteTableInfo) => col.name === 'execution_mode');

    if (!hasColumn) {
      this.db.prepare("ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'execute'").run();
    }
  }
  private ensureSessionsTableColumns(): void {
    interface SqliteTableInfo {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }

    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as SqliteTableInfo[];
    const existing = new Set(columns.map((col) => col.name));

    const addColumnBestEffort = (sql: string, columnName: string) => {
      try {
        this.db.prepare(sql).run();
        console.log(`[Database] Added missing ${columnName} column to sessions table`);
      } catch (error) {
        // Best-effort: don't block startup; logs help diagnose DBs in the wild.
        console.warn(`[Database] Failed to add missing ${columnName} column to sessions table:`, error);
      }
    };

    if (!existing.has('status_message')) {
      addColumnBestEffort("ALTER TABLE sessions ADD COLUMN status_message TEXT", 'status_message');
    }

    if (!existing.has('run_started_at')) {
      addColumnBestEffort("ALTER TABLE sessions ADD COLUMN run_started_at DATETIME", 'run_started_at');
    }

    if (!existing.has('execution_mode')) {
      addColumnBestEffort("ALTER TABLE sessions ADD COLUMN execution_mode TEXT DEFAULT 'execute'", 'execution_mode');
    }
  }

  private migrateTimelineMaskedPrompts(): void {
    try {
      const rows = this.db.prepare(`
        SELECT id, command, meta_json
        FROM timeline_events
        WHERE kind = 'cli.command'
          AND command LIKE '%<prompt>%'
          AND meta_json IS NOT NULL
      `).all() as Array<{ id: number; command: string | null; meta_json: string | null }>;

      if (rows.length === 0) return;

      const update = this.db.prepare(`UPDATE timeline_events SET command = ? WHERE id = ?`);

      for (const row of rows) {
        if (!row.meta_json) continue;
        let meta: unknown;
        try {
          meta = JSON.parse(row.meta_json);
        } catch {
          continue;
        }
        const record = meta as Record<string, unknown>;
        const cliCommand = typeof record.cliCommand === 'string' ? record.cliCommand : null;
        const cliArgs = Array.isArray(record.cliArgs) ? record.cliArgs : null;
        if (!cliCommand || !cliArgs || !cliArgs.every((a) => typeof a === 'string')) continue;

        const args = cliArgs as string[];
        const rendered = [cliCommand, ...args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))].join(' ').trim();
        if (!rendered) continue;

        update.run(rendered, row.id);
      }
    } catch {
      // Best-effort migration; never block startup.
    }
  }

  private migrateTimelineExtendedFields(): void {
    try {
      // Check if new columns already exist
      const tableInfo = this.db.prepare("PRAGMA table_info(timeline_events)").all() as Array<{ name: string }>;
      const existingColumns = new Set(tableInfo.map(col => col.name));

      // Add new columns for thinking, tool_use, tool_result, user_question events
      const columnsToAdd = [
        { name: 'tool_name', type: 'TEXT' },
        { name: 'tool_input', type: 'TEXT' },
        { name: 'tool_result', type: 'TEXT' },
        { name: 'is_error', type: 'INTEGER DEFAULT 0' },
        { name: 'content', type: 'TEXT' },
        { name: 'is_streaming', type: 'INTEGER DEFAULT 0' },
        { name: 'tool_use_id', type: 'TEXT' },
        { name: 'questions', type: 'TEXT' },
        { name: 'answers', type: 'TEXT' },
        { name: 'action_type', type: 'TEXT' },
        { name: 'thinking_id', type: 'TEXT' }  // Unique ID for streaming thinking updates
      ];

      for (const column of columnsToAdd) {
        if (!existingColumns.has(column.name)) {
          this.db.prepare(`ALTER TABLE timeline_events ADD COLUMN ${column.name} ${column.type}`).run();
        }
      }
    } catch (error) {
      // Best-effort migration; log but never block startup
      console.warn('[Database] Timeline extended fields migration warning:', error);
    }
  }

  // Project operations
  createProject(name: string, path: string, systemPrompt?: string, runScript?: string, buildScript?: string, defaultPermissionMode?: 'approve' | 'ignore', openIdeCommand?: string, commitMode?: 'structured' | 'checkpoint' | 'disabled', commitStructuredPromptTemplate?: string, commitCheckpointPrefix?: string): Project {
    // Get the max display_order for projects
    const maxOrderResult = this.db.prepare(`
      SELECT MAX(display_order) as max_order 
      FROM projects
    `).get() as { max_order: number | null };
    
    const displayOrder = (maxOrderResult?.max_order ?? -1) + 1;
    
    const result = this.db.prepare(`
      INSERT INTO projects (name, path, system_prompt, run_script, build_script, default_permission_mode, open_ide_command, display_order, commit_mode, commit_structured_prompt_template, commit_checkpoint_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, path, systemPrompt || null, runScript || null, buildScript || null, defaultPermissionMode || 'ignore', openIdeCommand || null, displayOrder, commitMode || 'checkpoint', commitStructuredPromptTemplate || null, commitCheckpointPrefix || 'checkpoint: ');
    
    const project = this.getProject(result.lastInsertRowid as number);
    if (!project) {
      throw new Error('Failed to create project');
    }
    return project;
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByPath(path: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Project | undefined;
  }

  getActiveProject(): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE active = 1 LIMIT 1').get() as Project | undefined;
  }

  getAllProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY display_order ASC, created_at ASC').all() as Project[];
  }

  updateProject(id: number, updates: Partial<Omit<Project, 'id' | 'created_at'>>): Project | undefined {
    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.path !== undefined) {
      fields.push('path = ?');
      values.push(updates.path);
    }
    if (updates.system_prompt !== undefined) {
      fields.push('system_prompt = ?');
      values.push(updates.system_prompt);
    }
    if (updates.run_script !== undefined) {
      fields.push('run_script = ?');
      values.push(updates.run_script);
    }
    if (updates.build_script !== undefined) {
      fields.push('build_script = ?');
      values.push(updates.build_script);
    }
    if (updates.default_permission_mode !== undefined) {
      fields.push('default_permission_mode = ?');
      values.push(updates.default_permission_mode);
    }
    if (updates.open_ide_command !== undefined) {
      fields.push('open_ide_command = ?');
      values.push(updates.open_ide_command);
    }
    if (updates.worktree_folder !== undefined) {
      fields.push('worktree_folder = ?');
      values.push(updates.worktree_folder);
    }
    if (updates.lastUsedModel !== undefined) {
      fields.push('lastUsedModel = ?');
      values.push(updates.lastUsedModel);
    }
    if (updates.active !== undefined) {
      fields.push('active = ?');
      values.push(updates.active ? 1 : 0);
    }
    if (updates.commit_mode !== undefined) {
      fields.push('commit_mode = ?');
      values.push(updates.commit_mode);
    }
    if (updates.commit_structured_prompt_template !== undefined) {
      fields.push('commit_structured_prompt_template = ?');
      values.push(updates.commit_structured_prompt_template);
    }
    if (updates.commit_checkpoint_prefix !== undefined) {
      fields.push('commit_checkpoint_prefix = ?');
      values.push(updates.commit_checkpoint_prefix);
    }

    if (fields.length === 0) {
      return this.getProject(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    this.db.prepare(`
      UPDATE projects 
      SET ${fields.join(', ')} 
      WHERE id = ?
    `).run(...values);
    
    return this.getProject(id);
  }

  setActiveProject(id: number): Project | undefined {
    // First deactivate all projects
    this.db.prepare('UPDATE projects SET active = 0').run();
    
    // Then activate the selected project
    this.db.prepare('UPDATE projects SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    
    return this.getProject(id);
  }

  deleteProject(id: number): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // Folder operations
  createFolder(name: string, projectId: number, parentFolderId?: string | null): Folder {
    // Validate inputs
    if (!name || typeof name !== 'string') {
      throw new Error('Folder name must be a non-empty string');
    }
    if (!projectId || typeof projectId !== 'number' || projectId <= 0) {
      throw new Error('Project ID must be a positive number');
    }
    
    // Validate parent folder if provided
    if (parentFolderId) {
      const parentFolder = this.getFolder(parentFolderId);
      if (!parentFolder) {
        throw new Error('Parent folder not found');
      }
      if (parentFolder.project_id !== projectId) {
        throw new Error('Parent folder belongs to a different project');
      }
      
      // Check nesting depth
      const depth = this.getFolderDepth(parentFolderId);
      if (depth >= 4) { // Parent is at depth 4, so child would be at depth 5
        throw new Error('Maximum nesting depth (5 levels) reached');
      }
    }
    
    const id = `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Get the max display_order - if this is a root-level folder (no parent),
    // we need to consider both folders and sessions since they share the same space
    let displayOrder: number;
    if (!parentFolderId) {
      // Root-level folder: check both folders and sessions
      const maxFolderOrder = this.db.prepare(`
        SELECT MAX(display_order) as max_order
        FROM folders
        WHERE project_id = ? AND parent_folder_id IS NULL
      `).get(projectId) as { max_order: number | null };

      const maxSessionOrder = this.db.prepare(`
        SELECT MAX(display_order) as max_order
        FROM sessions
        WHERE project_id = ? AND (archived = 0 OR archived IS NULL) AND folder_id IS NULL
      `).get(projectId) as { max_order: number | null };

      // Use the maximum of both to ensure no overlap
      const maxOrder = Math.max(
        maxFolderOrder?.max_order ?? -1,
        maxSessionOrder?.max_order ?? -1
      );
      displayOrder = maxOrder + 1;
    } else {
      // Nested folder: only check folders at the same level
      const maxOrder = this.db.prepare(`
        SELECT MAX(display_order) as max_order
        FROM folders
        WHERE project_id = ? AND parent_folder_id = ?
      `).get(projectId, parentFolderId) as { max_order: number | null };

      displayOrder = (maxOrder?.max_order ?? -1) + 1;
    }
    
    const stmt = this.db.prepare(`
      INSERT INTO folders (id, name, project_id, parent_folder_id, display_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(id, name, projectId, parentFolderId || null, displayOrder);

    fileLogger.state('Database', 'Folder created', { id, name, projectId, parentFolderId });
    return this.getFolder(id)!;
  }

  getFolder(id: string): Folder | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM folders WHERE id = ?
    `);
    return stmt.get(id) as Folder | undefined;
  }

  getFoldersForProject(projectId: number): Folder[] {
    const stmt = this.db.prepare(`
      SELECT * FROM folders
      WHERE project_id = ?
      ORDER BY display_order ASC, name ASC
    `);
    return stmt.all(projectId) as Folder[];
  }

  updateFolder(id: string, updates: { name?: string; display_order?: number; parent_folder_id?: string | null }): void {
    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    
    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    
    if (updates.display_order !== undefined) {
      fields.push('display_order = ?');
      values.push(updates.display_order);
    }
    
    if (updates.parent_folder_id !== undefined) {
      fields.push('parent_folder_id = ?');
      values.push(updates.parent_folder_id);
    }
    
    if (fields.length === 0) return;
    
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    
    const stmt = this.db.prepare(`
      UPDATE folders 
      SET ${fields.join(', ')} 
      WHERE id = ?
    `);
    
    stmt.run(...values);
  }

  deleteFolder(id: string): void {
    // Sessions will have their folder_id set to NULL due to ON DELETE SET NULL
    const stmt = this.db.prepare('DELETE FROM folders WHERE id = ?');
    stmt.run(id);
  }

  updateFolderDisplayOrder(folderId: string, newOrder: number): void {
    const stmt = this.db.prepare(`
      UPDATE folders 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    stmt.run(newOrder, folderId);
  }

  reorderFolders(projectId: number, folderOrders: Array<{ id: string; displayOrder: number }>): void {
    const stmt = this.db.prepare(`
      UPDATE folders
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND project_id = ?
    `);

    const transaction = this.db.transaction(() => {
      folderOrders.forEach(({ id, displayOrder }) => {
        stmt.run(displayOrder, id, projectId);
      });
    });

    transaction();
  }

  // Helper method to get the depth of a folder in the hierarchy
  getFolderDepth(folderId: string): number {
    let depth = 0;
    let currentId: string | null = folderId;
    
    while (currentId) {
      const folder = this.getFolder(currentId);
      if (!folder || !folder.parent_folder_id) break;
      depth++;
      currentId = folder.parent_folder_id;
      
      // Safety check to prevent infinite loops
      if (depth > 10) {
        console.error('[Database] Circular reference detected in folder hierarchy');
        break;
      }
    }
    
    return depth;
  }

  // Check if moving a folder would create a circular reference
  wouldCreateCircularReference(folderId: string, proposedParentId: string): boolean {
    // Check if proposedParentId is a descendant of folderId
    let currentId: string | null = proposedParentId;
    const visited = new Set<string>();
    
    while (currentId) {
      // If we find the folder we're trying to move in the parent chain, it's circular
      if (currentId === folderId) {
        return true;
      }
      
      // Safety check for circular references in existing data
      if (visited.has(currentId)) {
        console.error('[Database] Existing circular reference detected in folder hierarchy');
        return true;
      }
      visited.add(currentId);
      
      const folder = this.getFolder(currentId);
      if (!folder) break;
      currentId = folder.parent_folder_id || null;
    }
    
    return false;
  }

  // Project run commands operations
  createRunCommand(projectId: number, command: string, displayName?: string, orderIndex?: number): ProjectRunCommand {
    const result = this.db.prepare(`
      INSERT INTO project_run_commands (project_id, command, display_name, order_index)
      VALUES (?, ?, ?, ?)
    `).run(projectId, command, displayName || null, orderIndex || 0);
    
    const runCommand = this.getRunCommand(result.lastInsertRowid as number);
    if (!runCommand) {
      throw new Error('Failed to create run command');
    }
    return runCommand;
  }

  getRunCommand(id: number): ProjectRunCommand | undefined {
    return this.db.prepare('SELECT * FROM project_run_commands WHERE id = ?').get(id) as ProjectRunCommand | undefined;
  }

  getProjectRunCommands(projectId: number): ProjectRunCommand[] {
    return this.db.prepare('SELECT * FROM project_run_commands WHERE project_id = ? ORDER BY order_index ASC, id ASC').all(projectId) as ProjectRunCommand[];
  }

  updateRunCommand(id: number, updates: { command?: string; display_name?: string; order_index?: number }): ProjectRunCommand | undefined {
    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];

    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.display_name !== undefined) {
      fields.push('display_name = ?');
      values.push(updates.display_name);
    }
    if (updates.order_index !== undefined) {
      fields.push('order_index = ?');
      values.push(updates.order_index);
    }

    if (fields.length === 0) {
      return this.getRunCommand(id);
    }

    values.push(id);

    this.db.prepare(`
      UPDATE project_run_commands 
      SET ${fields.join(', ')} 
      WHERE id = ?
    `).run(...values);
    
    return this.getRunCommand(id);
  }

  deleteRunCommand(id: number): boolean {
    const result = this.db.prepare('DELETE FROM project_run_commands WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteProjectRunCommands(projectId: number): boolean {
    const result = this.db.prepare('DELETE FROM project_run_commands WHERE project_id = ?').run(projectId);
    return result.changes > 0;
  }

  // Session operations
  createSession(data: CreateSessionData): Session {
    return this.transaction(() => {
      // Get the max display_order for both sessions and folders in this project
      // Sessions and folders share the same display_order space within a project
      // Exclude main repo sessions as they have separate handling
      const maxSessionOrder = this.db.prepare(`
        SELECT MAX(display_order) as max_order
        FROM sessions
        WHERE project_id = ?
          AND (archived = 0 OR archived IS NULL)
          AND folder_id IS NULL
          AND (is_main_repo = 0 OR is_main_repo IS NULL)
      `).get(data.project_id) as { max_order: number | null };

      const maxFolderOrder = this.db.prepare(`
        SELECT MAX(display_order) as max_order
        FROM folders
        WHERE project_id = ? AND parent_folder_id IS NULL
      `).get(data.project_id) as { max_order: number | null };

      // Use the maximum of both to ensure no overlap
      const maxOrder = Math.max(
        maxSessionOrder?.max_order ?? -1,
        maxFolderOrder?.max_order ?? -1
      );
      const displayOrder = maxOrder + 1;
      
      this.db.prepare(`
        INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, status, project_id, folder_id, permission_mode, is_main_repo, display_order, auto_commit, tool_type, base_commit, base_branch, commit_mode, commit_mode_settings)
        VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.id,
        data.name,
        data.initial_prompt,
        data.worktree_name,
        data.worktree_path,
        data.project_id,
        data.folder_id || null,
        data.permission_mode || 'ignore',
        data.is_main_repo ? 1 : 0,
        displayOrder,
        data.auto_commit !== undefined ? (data.auto_commit ? 1 : 0) : 1,
        data.tool_type || 'claude',
        data.base_commit || null,
        data.base_branch || null,
        data.commit_mode || null,
        data.commit_mode_settings || null
      );
      
      const session = this.getSession(data.id);
      if (!session) {
        throw new Error('Failed to create session');
      }
      return session;
    });
  }

  getSession(id: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getAllSessions(projectId?: number): Session[] {
    if (projectId !== undefined) {
      return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC').all(projectId) as Session[];
    }
    return this.db.prepare('SELECT * FROM sessions WHERE (archived = 0 OR archived IS NULL) AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY display_order ASC, created_at DESC').all() as Session[];
  }

  getAllSessionsIncludingArchived(): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY created_at DESC').all() as Session[];
  }

  getArchivedSessions(projectId?: number): Session[] {
    if (projectId !== undefined) {
      return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND archived = 1 AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY updated_at DESC').all(projectId) as Session[];
    }
    return this.db.prepare('SELECT * FROM sessions WHERE archived = 1 AND (is_main_repo = 0 OR is_main_repo IS NULL) ORDER BY updated_at DESC').all() as Session[];
  }

  getMainRepoSession(projectId: number): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND is_main_repo = 1 AND (archived = 0 OR archived IS NULL)').get(projectId) as Session | undefined;
  }

  checkSessionNameExists(name: string): boolean {
    const result = this.db.prepare('SELECT id FROM sessions WHERE (name = ? OR worktree_name = ?) LIMIT 1').get(name, name);
    return result !== undefined;
  }

  updateSession(id: string, data: UpdateSessionData): Session | undefined {
    const updates: string[] = [];
    const values: (string | number | boolean | null)[] = [];

    if (data.name !== undefined) {
      updates.push('name = ?');
      values.push(data.name);
    }
    if (data.worktree_path !== undefined) {
      updates.push('worktree_path = ?');
      values.push(data.worktree_path);
    }
    if (data.worktree_name !== undefined) {
      updates.push('worktree_name = ?');
      values.push(data.worktree_name);
    }
    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }
    if (data.status_message !== undefined) {
      updates.push('status_message = ?');
      values.push(data.status_message);
    }
    if (data.base_commit !== undefined) {
      updates.push('base_commit = ?');
      values.push(data.base_commit);
    }
    if (data.base_branch !== undefined) {
      updates.push('base_branch = ?');
      values.push(data.base_branch);
    }
    if (data.folder_id !== undefined) {
      updates.push('folder_id = ?');
      values.push(data.folder_id);
    }
    if (data.last_output !== undefined) {
      updates.push('last_output = ?');
      values.push(data.last_output);
    }
    if (data.exit_code !== undefined) {
      updates.push('exit_code = ?');
      values.push(data.exit_code);
    }
    if (data.pid !== undefined) {
      updates.push('pid = ?');
      values.push(data.pid);
    }
    if (data.claude_session_id !== undefined) {
      updates.push('claude_session_id = ?');
      values.push(data.claude_session_id);
    }
    if (data.run_started_at !== undefined) {
      if (data.run_started_at === 'CURRENT_TIMESTAMP') {
        updates.push('run_started_at = CURRENT_TIMESTAMP');
      } else {
        updates.push('run_started_at = ?');
        values.push(data.run_started_at);
      }
    }
    if (data.is_favorite !== undefined) {
      updates.push('is_favorite = ?');
      values.push(data.is_favorite ? 1 : 0);
    }
    if (data.auto_commit !== undefined) {
      updates.push('auto_commit = ?');
      values.push(data.auto_commit ? 1 : 0);
    }
    if (data.skip_continue_next !== undefined) {
      updates.push('skip_continue_next = ?');
      values.push(data.skip_continue_next ? 1 : 0);
    }
    if (data.commit_mode !== undefined) {
      updates.push('commit_mode = ?');
      values.push(data.commit_mode);
    }
    if (data.commit_mode_settings !== undefined) {
      updates.push('commit_mode_settings = ?');
      values.push(data.commit_mode_settings);
    }
    if (data.archived !== undefined) {
      updates.push('archived = ?');
      values.push(data.archived ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.getSession(id);
    }

    // Only update the updated_at timestamp if we're changing something other than is_favorite, auto_commit, skip_continue_next, commit_mode, or commit_mode_settings
    // This prevents the session from showing as "unviewed" when just toggling these settings
    const isOnlyToggleUpdate = updates.length === 1 && (updates[0] === 'is_favorite = ?' || updates[0] === 'auto_commit = ?' || updates[0] === 'skip_continue_next = ?' || updates[0] === 'commit_mode = ?' || updates[0] === 'commit_mode_settings = ?');
    if (!isOnlyToggleUpdate) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
    }
    values.push(id);

    const sql = `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    // Log important state changes to file
    const importantChanges: Record<string, unknown> = {};
    if (data.name !== undefined) importantChanges.name = data.name;
    if (data.worktree_path !== undefined) importantChanges.worktree_path = data.worktree_path;
    if (data.worktree_name !== undefined) importantChanges.worktree_name = data.worktree_name;
    if (data.status !== undefined) importantChanges.status = data.status;
    if (data.archived !== undefined) importantChanges.archived = data.archived;

    if (Object.keys(importantChanges).length > 0) {
      fileLogger.state('Database', `Session updated: ${id.substring(0, 8)}`, importantChanges);
    }

    return this.getSession(id);
  }

  markSessionAsViewed(id: string): Session | undefined {
    this.db.prepare(`
      UPDATE sessions 
      SET last_viewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(id);
    
    return this.getSession(id);
  }

  archiveSession(id: string): boolean {
    const result = this.db.prepare('UPDATE sessions SET archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return result.changes > 0;
  }

  restoreSession(id: string): boolean {
    const result = this.db.prepare('UPDATE sessions SET archived = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteSessionPermanently(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM timeline_events WHERE session_id = ?').run(id);
      const res = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return res.changes > 0;
    });
    return tx();
  }

  // Session output operations
  addSessionOutput(sessionId: string, type: 'stdout' | 'stderr' | 'system' | 'json' | 'error', data: string): void {
    this.db.prepare(`
      INSERT INTO session_outputs (session_id, type, data)
      VALUES (?, ?, ?)
    `).run(sessionId, type, data);
  }

  getSessionOutputs(sessionId: string, limit?: number): SessionOutput[] {
    const effectiveLimit = typeof limit === 'number' ? limit : Number(limit);
    if (Number.isFinite(effectiveLimit) && effectiveLimit > 0) {
      const rows = this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE session_id = ? 
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `).all(sessionId, effectiveLimit) as SessionOutput[];
      return rows.reverse();
    }

    return this.db.prepare(`
      SELECT * FROM session_outputs 
      WHERE session_id = ? 
      ORDER BY timestamp ASC, id ASC
    `).all(sessionId) as SessionOutput[];
  }

  getSessionOutputsForPanel(panelId: string, limit?: number): SessionOutput[] {
    const effectiveLimit = typeof limit === 'number' ? limit : Number(limit);
    if (Number.isFinite(effectiveLimit) && effectiveLimit > 0) {
      const rows = this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE panel_id = ? 
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `).all(panelId, effectiveLimit) as SessionOutput[];
      return rows.reverse();
    }

    return this.db.prepare(`
      SELECT * FROM session_outputs 
      WHERE panel_id = ? 
      ORDER BY timestamp ASC, id ASC
    `).all(panelId) as SessionOutput[];
  }

  getRecentSessionOutputs(sessionId: string, since?: Date): SessionOutput[] {
    if (since) {
      return this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE session_id = ? AND timestamp > ? 
        ORDER BY timestamp ASC
      `).all(sessionId, since.toISOString()) as SessionOutput[];
    } else {
      return this.getSessionOutputs(sessionId);
    }
  }

  clearSessionOutputs(sessionId: string): void {
    this.db.prepare('DELETE FROM session_outputs WHERE session_id = ?').run(sessionId);
  }

  // Claude panel output operations - use panel_id for Claude-specific data
  addPanelOutput(panelId: string, type: 'stdout' | 'stderr' | 'system' | 'json' | 'error', data: string): void {
    // Get the session_id from the panel
    const panel = this.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    
    this.db.prepare(`
      INSERT INTO session_outputs (session_id, panel_id, type, data)
      VALUES (?, ?, ?, ?)
    `).run(panel.sessionId, panelId, type, data);
  }

  addTimelineEvent(data: CreateTimelineEventData): TimelineEvent {
    const getNextSeq = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM timeline_events
      WHERE session_id = ?
    `);

    // Check if thinking_id exists (for streaming thinking updates)
    const findByThinkingId = this.db.prepare(`
      SELECT id, seq FROM timeline_events
      WHERE session_id = ? AND thinking_id = ? AND kind = 'thinking'
      LIMIT 1
    `);

    // Check if tool_use_id exists (for user_question status updates)
    const findByToolUseId = this.db.prepare(`
      SELECT id, seq FROM timeline_events
      WHERE session_id = ? AND tool_use_id = ? AND kind = 'user_question'
      LIMIT 1
    `);

    const insert = this.db.prepare(`
      INSERT INTO timeline_events (
        session_id, seq, timestamp, kind, status, command, cwd, duration_ms, exit_code, panel_id, tool, meta_json,
        tool_name, tool_input, tool_result, is_error, content, is_streaming, tool_use_id, questions, answers, action_type, thinking_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateThinking = this.db.prepare(`
      UPDATE timeline_events
      SET content = ?, is_streaming = ?, timestamp = ?
      WHERE id = ?
    `);

    const updateUserQuestion = this.db.prepare(`
      UPDATE timeline_events
      SET status = ?, answers = ?, timestamp = ?
      WHERE id = ?
    `);

    const select = this.db.prepare(`
      SELECT
        id,
        session_id,
        seq,
        timestamp,
        kind,
        status,
        command,
        cwd,
        duration_ms,
        exit_code,
        panel_id,
        tool,
        meta_json,
        tool_name,
        tool_input,
        tool_result,
        is_error,
        content,
        is_streaming,
        tool_use_id,
        questions,
        answers,
        action_type,
        thinking_id
      FROM timeline_events
      WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      const metaJson = data.meta ? JSON.stringify(data.meta) : null;

      // Handle streaming thinking updates (UPSERT)
      if (data.thinking_id && data.kind === 'thinking') {
        const existing = findByThinkingId.get(data.session_id, data.thinking_id) as { id: number; seq: number } | undefined;

        if (existing) {
          // Update existing thinking event
          updateThinking.run(
            data.content ?? null,
            data.is_streaming ?? null,
            data.timestamp,
            existing.id
          );

          const updated = select.get(existing.id) as {
            id: number;
            session_id: string;
            seq: number;
            timestamp: string;
            kind: string;
            status: string | null;
            command: string | null;
            cwd: string | null;
            duration_ms: number | null;
            exit_code: number | null;
            panel_id: string | null;
            tool: string | null;
            meta_json: string | null;
            tool_name: string | null;
            tool_input: string | null;
            tool_result: string | null;
            is_error: number | null;
            content: string | null;
            is_streaming: number | null;
            tool_use_id: string | null;
            questions: string | null;
            answers: string | null;
            action_type: string | null;
            thinking_id: string | null;
          };

          return {
            id: updated.id,
            session_id: updated.session_id,
            seq: updated.seq,
            timestamp: updated.timestamp,
            kind: updated.kind as TimelineEvent['kind'],
            status: updated.status ? (updated.status as TimelineEvent['status']) : undefined,
            command: updated.command ?? undefined,
            cwd: updated.cwd ?? undefined,
            duration_ms: updated.duration_ms ?? undefined,
            exit_code: updated.exit_code ?? undefined,
            panel_id: updated.panel_id ?? undefined,
            tool: updated.tool ? (updated.tool as TimelineEvent['tool']) : undefined,
            meta: updated.meta_json ? (JSON.parse(updated.meta_json) as Record<string, unknown>) : undefined,
            tool_name: updated.tool_name ?? undefined,
            tool_input: updated.tool_input ?? undefined,
            tool_result: updated.tool_result ?? undefined,
            is_error: updated.is_error ?? undefined,
            content: updated.content ?? undefined,
            is_streaming: updated.is_streaming ?? undefined,
            tool_use_id: updated.tool_use_id ?? undefined,
            questions: updated.questions ?? undefined,
            answers: updated.answers ?? undefined,
            action_type: updated.action_type ?? undefined,
            thinking_id: updated.thinking_id ?? undefined
          } satisfies TimelineEvent;
        }
        // Fall through to INSERT if not found
      }

      // Handle user_question status updates (UPSERT by tool_use_id)
      if (data.tool_use_id && data.kind === 'user_question') {
        const existing = findByToolUseId.get(data.session_id, data.tool_use_id) as { id: number; seq: number } | undefined;

        if (existing) {
          // Update existing user_question event (e.g., pending -> answered)
          updateUserQuestion.run(
            data.status ?? null,
            data.answers ?? null,
            data.timestamp,
            existing.id
          );

          const updated = select.get(existing.id) as {
            id: number;
            session_id: string;
            seq: number;
            timestamp: string;
            kind: string;
            status: string | null;
            command: string | null;
            cwd: string | null;
            duration_ms: number | null;
            exit_code: number | null;
            panel_id: string | null;
            tool: string | null;
            meta_json: string | null;
            tool_name: string | null;
            tool_input: string | null;
            tool_result: string | null;
            is_error: number | null;
            content: string | null;
            is_streaming: number | null;
            tool_use_id: string | null;
            questions: string | null;
            answers: string | null;
            action_type: string | null;
            thinking_id: string | null;
          };

          return {
            id: updated.id,
            session_id: updated.session_id,
            seq: updated.seq,
            timestamp: updated.timestamp,
            kind: updated.kind as TimelineEvent['kind'],
            status: updated.status ? (updated.status as TimelineEvent['status']) : undefined,
            command: updated.command ?? undefined,
            cwd: updated.cwd ?? undefined,
            duration_ms: updated.duration_ms ?? undefined,
            exit_code: updated.exit_code ?? undefined,
            panel_id: updated.panel_id ?? undefined,
            tool: updated.tool ? (updated.tool as TimelineEvent['tool']) : undefined,
            meta: updated.meta_json ? (JSON.parse(updated.meta_json) as Record<string, unknown>) : undefined,
            tool_name: updated.tool_name ?? undefined,
            tool_input: updated.tool_input ?? undefined,
            tool_result: updated.tool_result ?? undefined,
            is_error: updated.is_error ?? undefined,
            content: updated.content ?? undefined,
            is_streaming: updated.is_streaming ?? undefined,
            tool_use_id: updated.tool_use_id ?? undefined,
            questions: updated.questions ?? undefined,
            answers: updated.answers ?? undefined,
            action_type: updated.action_type ?? undefined,
            thinking_id: updated.thinking_id ?? undefined
          } satisfies TimelineEvent;
        }
        // Fall through to INSERT if not found
      }

      // Normal INSERT (or first INSERT for thinking/user_question)
      const row = getNextSeq.get(data.session_id) as { next_seq: number };
      const nextSeq = row?.next_seq || 1;

      const res = insert.run(
        data.session_id,
        nextSeq,
        data.timestamp,
        data.kind,
        data.status ?? null,
        data.command ?? null,
        data.cwd ?? null,
        data.duration_ms ?? null,
        data.exit_code ?? null,
        data.panel_id ?? null,
        data.tool ?? null,
        metaJson,
        data.tool_name ?? null,
        data.tool_input ?? null,
        data.tool_result ?? null,
        data.is_error ?? null,
        data.content ?? null,
        data.is_streaming ?? null,
        data.tool_use_id ?? null,
        data.questions ?? null,
        data.answers ?? null,
        data.action_type ?? null,
        data.thinking_id ?? null
      ) as { lastInsertRowid: number };

      const inserted = select.get(res.lastInsertRowid) as {
        id: number;
        session_id: string;
        seq: number;
        timestamp: string;
        kind: string;
        status: string | null;
        command: string | null;
        cwd: string | null;
        duration_ms: number | null;
        exit_code: number | null;
        panel_id: string | null;
        tool: string | null;
        meta_json: string | null;
        tool_name: string | null;
        tool_input: string | null;
        tool_result: string | null;
        is_error: number | null;
        content: string | null;
        is_streaming: number | null;
        tool_use_id: string | null;
        questions: string | null;
        answers: string | null;
        action_type: string | null;
        thinking_id: string | null;
      };

      return {
        id: inserted.id,
        session_id: inserted.session_id,
        seq: inserted.seq,
        timestamp: inserted.timestamp,
        kind: inserted.kind as TimelineEvent['kind'],
        status: inserted.status ? (inserted.status as TimelineEvent['status']) : undefined,
        command: inserted.command ?? undefined,
        cwd: inserted.cwd ?? undefined,
        duration_ms: inserted.duration_ms ?? undefined,
        exit_code: inserted.exit_code ?? undefined,
        panel_id: inserted.panel_id ?? undefined,
        tool: inserted.tool ? (inserted.tool as TimelineEvent['tool']) : undefined,
        meta: inserted.meta_json ? (JSON.parse(inserted.meta_json) as Record<string, unknown>) : undefined,
        tool_name: inserted.tool_name ?? undefined,
        tool_input: inserted.tool_input ?? undefined,
        tool_result: inserted.tool_result ?? undefined,
        is_error: inserted.is_error ?? undefined,
        content: inserted.content ?? undefined,
        is_streaming: inserted.is_streaming ?? undefined,
        tool_use_id: inserted.tool_use_id ?? undefined,
        questions: inserted.questions ?? undefined,
        answers: inserted.answers ?? undefined,
        action_type: inserted.action_type ?? undefined,
        thinking_id: inserted.thinking_id ?? undefined
      } satisfies TimelineEvent;
    });

    return tx();
  }

  updateTimelineAssistantEvent(id: number, command: string, isStreaming: number | null, timestamp: string): TimelineEvent {
    const update = this.db.prepare(`
      UPDATE timeline_events
      SET command = ?, is_streaming = ?, timestamp = ?
      WHERE id = ?
    `);

    const select = this.db.prepare(`
      SELECT
        id,
        session_id,
        seq,
        timestamp,
        kind,
        status,
        command,
        cwd,
        duration_ms,
        exit_code,
        panel_id,
        tool,
        meta_json,
        tool_name,
        tool_input,
        tool_result,
        is_error,
        content,
        is_streaming,
        tool_use_id,
        questions,
        answers,
        action_type,
        thinking_id
      FROM timeline_events
      WHERE id = ?
    `);

    update.run(command ?? null, isStreaming, timestamp, id);

    const updated = select.get(id) as {
      id: number;
      session_id: string;
      seq: number;
      timestamp: string;
      kind: string;
      status: string | null;
      command: string | null;
      cwd: string | null;
      duration_ms: number | null;
      exit_code: number | null;
      panel_id: string | null;
      tool: string | null;
      meta_json: string | null;
      tool_name: string | null;
      tool_input: string | null;
      tool_result: string | null;
      is_error: number | null;
      content: string | null;
      is_streaming: number | null;
      tool_use_id: string | null;
      questions: string | null;
      answers: string | null;
      action_type: string | null;
      thinking_id: string | null;
    } | undefined;

    if (!updated) {
      throw new Error(`Timeline event not found: ${id}`);
    }

    return {
      id: updated.id,
      session_id: updated.session_id,
      seq: updated.seq,
      timestamp: updated.timestamp,
      kind: updated.kind as TimelineEvent['kind'],
      status: updated.status ? (updated.status as TimelineEvent['status']) : undefined,
      command: updated.command ?? undefined,
      cwd: updated.cwd ?? undefined,
      duration_ms: updated.duration_ms ?? undefined,
      exit_code: updated.exit_code ?? undefined,
      panel_id: updated.panel_id ?? undefined,
      tool: updated.tool ? (updated.tool as TimelineEvent['tool']) : undefined,
      meta: updated.meta_json ? (JSON.parse(updated.meta_json) as Record<string, unknown>) : undefined,
      tool_name: updated.tool_name ?? undefined,
      tool_input: updated.tool_input ?? undefined,
      tool_result: updated.tool_result ?? undefined,
      is_error: updated.is_error ?? undefined,
      content: updated.content ?? undefined,
      is_streaming: updated.is_streaming ?? undefined,
      tool_use_id: updated.tool_use_id ?? undefined,
      questions: updated.questions ?? undefined,
      answers: updated.answers ?? undefined,
      action_type: updated.action_type ?? undefined,
      thinking_id: updated.thinking_id ?? undefined
    } satisfies TimelineEvent;
  }

  getTimelineEvents(sessionId: string): TimelineEvent[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        session_id,
        seq,
        timestamp,
        kind,
        status,
        command,
        cwd,
        duration_ms,
        exit_code,
        panel_id,
        tool,
        meta_json,
        tool_name,
        tool_input,
        tool_result,
        is_error,
        content,
        is_streaming,
        tool_use_id,
        questions,
        answers,
        action_type,
        thinking_id
      FROM timeline_events
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(sessionId) as Array<{
      id: number;
      session_id: string;
      seq: number;
      timestamp: string;
      kind: string;
      status: string | null;
      command: string | null;
      cwd: string | null;
      duration_ms: number | null;
      exit_code: number | null;
      panel_id: string | null;
      tool: string | null;
      meta_json: string | null;
      tool_name: string | null;
      tool_input: string | null;
      tool_result: string | null;
      is_error: number | null;
      content: string | null;
      is_streaming: number | null;
      tool_use_id: string | null;
      questions: string | null;
      answers: string | null;
      action_type: string | null;
      thinking_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      seq: row.seq,
      timestamp: row.timestamp,
      kind: row.kind as TimelineEvent['kind'],
      status: row.status ? (row.status as TimelineEvent['status']) : undefined,
      command: row.command ?? undefined,
      cwd: row.cwd ?? undefined,
      duration_ms: row.duration_ms ?? undefined,
      exit_code: row.exit_code ?? undefined,
      panel_id: row.panel_id ?? undefined,
      tool: row.tool ? (row.tool as TimelineEvent['tool']) : undefined,
      meta: row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : undefined,
      tool_name: row.tool_name ?? undefined,
      tool_input: row.tool_input ?? undefined,
      tool_result: row.tool_result ?? undefined,
      is_error: row.is_error ?? undefined,
      content: row.content ?? undefined,
      is_streaming: row.is_streaming ?? undefined,
      tool_use_id: row.tool_use_id ?? undefined,
      questions: row.questions ?? undefined,
      answers: row.answers ?? undefined,
      action_type: row.action_type ?? undefined,
      thinking_id: row.thinking_id ?? undefined
    }));
  }

  getPanelOutputs(panelId: string, limit?: number): SessionOutput[] {
    const effectiveLimit = typeof limit === 'number' ? limit : Number(limit);
    if (Number.isFinite(effectiveLimit) && effectiveLimit > 0) {
      const rows = this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE panel_id = ? 
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `).all(panelId, effectiveLimit) as SessionOutput[];
      return rows.reverse();
    }

    return this.db.prepare(`
      SELECT * FROM session_outputs 
      WHERE panel_id = ? 
      ORDER BY timestamp ASC, id ASC
    `).all(panelId) as SessionOutput[];
  }

  getRecentPanelOutputs(panelId: string, since?: Date): SessionOutput[] {
    if (since) {
      return this.db.prepare(`
        SELECT * FROM session_outputs 
        WHERE panel_id = ? AND timestamp > ? 
        ORDER BY timestamp ASC
      `).all(panelId, since.toISOString()) as SessionOutput[];
    } else {
      return this.getPanelOutputs(panelId);
    }
  }

  clearPanelOutputs(panelId: string): void {
    this.db.prepare('DELETE FROM session_outputs WHERE panel_id = ?').run(panelId);
  }

  // Conversation message operations
  addConversationMessage(sessionId: string, messageType: 'user' | 'assistant', content: string): void {
    this.db.prepare(`
      INSERT INTO conversation_messages (session_id, message_type, content)
      VALUES (?, ?, ?)
    `).run(sessionId, messageType, content);
  }

  getConversationMessages(sessionId: string): ConversationMessage[] {
    return this.db.prepare(`
      SELECT * FROM conversation_messages 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as ConversationMessage[];
  }

  clearConversationMessages(sessionId: string): void {
    this.db.prepare('DELETE FROM conversation_messages WHERE session_id = ?').run(sessionId);
  }

  // Claude panel conversation message operations - use panel_id for Claude-specific data
  addPanelConversationMessage(panelId: string, messageType: 'user' | 'assistant', content: string): void {
    // Get the session_id from the panel
    const panel = this.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    
    this.db.prepare(`
      INSERT INTO conversation_messages (session_id, panel_id, message_type, content)
      VALUES (?, ?, ?, ?)
    `).run(panel.sessionId, panelId, messageType, content);
  }

  getPanelConversationMessages(panelId: string): ConversationMessage[] {
    return this.db.prepare(`
      SELECT * FROM conversation_messages 
      WHERE panel_id = ? 
      ORDER BY timestamp ASC
    `).all(panelId) as ConversationMessage[];
  }

  clearPanelConversationMessages(panelId: string): void {
    this.db.prepare('DELETE FROM conversation_messages WHERE panel_id = ?').run(panelId);
  }

  // Cleanup operations
  getActiveSessions(): Session[] {
    // Sessions that were mid-execution when the app exited.
    return this.db.prepare("SELECT * FROM sessions WHERE status IN ('running', 'initializing', 'pending')").all() as Session[];
  }

  markSessionsAsStopped(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    
    const placeholders = sessionIds.map(() => '?').join(',');
    this.db.prepare(`
      UPDATE sessions 
      SET status = 'waiting', updated_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `).run(...sessionIds);
  }

  // Prompt marker operations
  addPromptMarker(sessionId: string, promptText: string, outputIndex: number, outputLine?: number): number {
    const result = this.db.prepare(`
      INSERT INTO prompt_markers (session_id, prompt_text, output_index, output_line, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(sessionId, promptText, outputIndex, outputLine);
    return result.lastInsertRowid as number;
  }

  getPromptMarkers(sessionId: string): PromptMarker[] {
    const markers = this.db.prepare(`
      SELECT 
        id,
        session_id,
        prompt_text,
        output_index,
        output_line,
        datetime(timestamp) || 'Z' as timestamp,
        CASE 
          WHEN completion_timestamp IS NOT NULL 
          THEN datetime(completion_timestamp) || 'Z'
          ELSE NULL
        END as completion_timestamp
      FROM prompt_markers 
      WHERE session_id = ? 
      ORDER BY timestamp ASC
    `).all(sessionId) as PromptMarker[];
    
    return markers;
  }

  getPanelPromptMarkers(panelId: string): PromptMarker[] {
    const markers = this.db.prepare(`
      SELECT 
        id,
        session_id,
        panel_id,
        prompt_text,
        output_index,
        output_line,
        datetime(timestamp) || 'Z' as timestamp,
        CASE 
          WHEN completion_timestamp IS NOT NULL 
          THEN datetime(completion_timestamp) || 'Z'
          ELSE NULL
        END as completion_timestamp
      FROM prompt_markers 
      WHERE panel_id = ? 
      ORDER BY timestamp ASC
    `).all(panelId) as PromptMarker[];
    
    return markers;
  }

  updatePromptMarkerLine(id: number, outputLine: number): void {
    this.db.prepare(`
      UPDATE prompt_markers 
      SET output_line = ? 
      WHERE id = ?
    `).run(outputLine, id);
  }

  updatePromptMarkerCompletion(sessionId: string, timestamp?: string): void {
    // Update the most recent prompt marker for this session with completion timestamp
    // Use datetime() to ensure proper UTC timestamp handling
    if (timestamp) {
      // If timestamp is provided, use datetime() to normalize it
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime(?) 
        WHERE session_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE session_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(timestamp, sessionId, sessionId);
    } else {
      // If no timestamp, use current UTC time
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime('now') 
        WHERE session_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE session_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(sessionId, sessionId);
    }
  }

  // Claude panel prompt marker operations - use panel_id for Claude-specific data
  addPanelPromptMarker(panelId: string, promptText: string, outputIndex: number, outputLine?: number): number {
    const panel = this.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }
    const result = this.db.prepare(`
      INSERT INTO prompt_markers (session_id, panel_id, prompt_text, output_index, output_line, timestamp)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(panel.sessionId, panelId, promptText, outputIndex, outputLine);
    return result.lastInsertRowid as number;
  }


  updatePanelPromptMarkerCompletion(panelId: string, timestamp?: string): void {
    // Update the most recent prompt marker for this panel with completion timestamp
    // Use datetime() to ensure proper UTC timestamp handling
    if (timestamp) {
      // If timestamp is provided, use datetime() to normalize it
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime(?) 
        WHERE panel_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE panel_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(timestamp, panelId, panelId);
    } else {
      // If no timestamp, use current UTC time
      this.db.prepare(`
        UPDATE prompt_markers 
        SET completion_timestamp = datetime('now') 
        WHERE panel_id = ? 
        AND id = (
          SELECT id FROM prompt_markers 
          WHERE panel_id = ? 
          ORDER BY timestamp DESC 
          LIMIT 1
        )
      `).run(panelId, panelId);
    }
  }

  // Execution diff operations
  createExecutionDiff(data: CreateExecutionDiffData): ExecutionDiff {
    const result = this.db.prepare(`
      INSERT INTO execution_diffs (
        session_id, prompt_marker_id, execution_sequence, git_diff, 
        files_changed, stats_additions, stats_deletions, stats_files_changed,
        before_commit_hash, after_commit_hash, commit_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.session_id,
      data.prompt_marker_id || null,
      data.execution_sequence,
      data.git_diff || null,
      data.files_changed ? JSON.stringify(data.files_changed) : null,
      data.stats_additions || 0,
      data.stats_deletions || 0,
      data.stats_files_changed || 0,
      data.before_commit_hash || null,
      data.after_commit_hash || null,
      data.commit_message || null
    );

    const diff = this.db.prepare('SELECT * FROM execution_diffs WHERE id = ?').get(result.lastInsertRowid) as ExecutionDiffRow | undefined;
    if (!diff) {
      throw new Error('Failed to retrieve created execution diff');
    }
    return this.convertDbExecutionDiff(diff);
  }

  getExecutionDiffs(sessionId: string): ExecutionDiff[] {
    const rows = this.db.prepare(`
      SELECT * FROM execution_diffs 
      WHERE session_id = ? 
      ORDER BY execution_sequence ASC
    `).all(sessionId) as ExecutionDiffRow[];
    
    return rows.map(this.convertDbExecutionDiff.bind(this));
  }

  getExecutionDiff(id: number): ExecutionDiff | undefined {
    const row = this.db.prepare('SELECT * FROM execution_diffs WHERE id = ?').get(id) as ExecutionDiffRow | undefined;
    return row ? this.convertDbExecutionDiff(row) : undefined;
  }

  getNextExecutionSequence(sessionId: string): number {
    const result = this.db.prepare(`
      SELECT MAX(execution_sequence) as max_seq 
      FROM execution_diffs 
      WHERE session_id = ?
    `).get(sessionId) as { max_seq: number | null } | undefined;
    
    return (result?.max_seq || 0) + 1;
  }

  private convertDbExecutionDiff(row: ExecutionDiffRow): ExecutionDiff {
    return {
      id: row.id,
      session_id: row.session_id,
      prompt_marker_id: row.prompt_marker_id,
      execution_sequence: row.execution_sequence,
      git_diff: row.git_diff,
      files_changed: row.files_changed ? JSON.parse(row.files_changed) : [],
      stats_additions: row.stats_additions,
      stats_deletions: row.stats_deletions,
      stats_files_changed: row.stats_files_changed,
      before_commit_hash: row.before_commit_hash,
      after_commit_hash: row.after_commit_hash,
      commit_message: row.commit_message,
      timestamp: row.timestamp
    };
  }

  // Claude panel execution diff operations - use panel_id for Claude-specific data
  createPanelExecutionDiff(data: CreatePanelExecutionDiffData): ExecutionDiff {
    const result = this.db.prepare(`
      INSERT INTO execution_diffs (
        panel_id, prompt_marker_id, execution_sequence, git_diff, 
        files_changed, stats_additions, stats_deletions, stats_files_changed,
        before_commit_hash, after_commit_hash, commit_message
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.panel_id,
      data.prompt_marker_id || null,
      data.execution_sequence,
      data.git_diff || null,
      data.files_changed ? JSON.stringify(data.files_changed) : null,
      data.stats_additions || 0,
      data.stats_deletions || 0,
      data.stats_files_changed || 0,
      data.before_commit_hash || null,
      data.after_commit_hash || null,
      data.commit_message || null
    );

    const diff = this.db.prepare('SELECT * FROM execution_diffs WHERE id = ?').get(result.lastInsertRowid) as ExecutionDiffRow | undefined;
    if (!diff) {
      throw new Error('Failed to retrieve created panel execution diff');
    }
    return this.convertDbExecutionDiff(diff);
  }

  getPanelExecutionDiffs(panelId: string): ExecutionDiff[] {
    const rows = this.db.prepare(`
      SELECT * FROM execution_diffs 
      WHERE panel_id = ? 
      ORDER BY execution_sequence ASC
    `).all(panelId) as ExecutionDiffRow[];
    
    return rows.map(this.convertDbExecutionDiff.bind(this));
  }

  getNextPanelExecutionSequence(panelId: string): number {
    const result = this.db.prepare(`
      SELECT MAX(execution_sequence) as max_seq 
      FROM execution_diffs 
      WHERE panel_id = ?
    `).get(panelId) as { max_seq: number | null } | undefined;
    
    return (result?.max_seq || 0) + 1;
  }

  // Display order operations
  updateProjectDisplayOrder(projectId: number, displayOrder: number): void {
    this.db.prepare(`
      UPDATE projects 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(displayOrder, projectId);
  }

  updateSessionDisplayOrder(sessionId: string, displayOrder: number): void {
    this.db.prepare(`
      UPDATE sessions 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(displayOrder, sessionId);
  }

  reorderProjects(projectOrders: Array<{ id: number; displayOrder: number }>): void {
    const stmt = this.db.prepare(`
      UPDATE projects 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const updateMany = this.db.transaction((orders: Array<{ id: number; displayOrder: number }>) => {
      for (const { id, displayOrder } of orders) {
        stmt.run(displayOrder, id);
      }
    });
    
    updateMany(projectOrders);
  }

  reorderSessions(sessionOrders: Array<{ id: string; displayOrder: number }>): void {
    const stmt = this.db.prepare(`
      UPDATE sessions 
      SET display_order = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `);
    
    const updateMany = this.db.transaction((orders: Array<{ id: string; displayOrder: number }>) => {
      for (const { id, displayOrder } of orders) {
        stmt.run(displayOrder, id);
      }
    });
    
    updateMany(sessionOrders);
  }

  // Debug method to check table structure
  getTableStructure(tableName: 'folders' | 'sessions'): { 
    columns: Array<{ 
      cid: number; 
      name: string; 
      type: string; 
      notnull: number; 
      dflt_value: unknown; 
      pk: number 
    }>;
    foreignKeys: Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    indexes: Array<{
      name: string;
      tbl_name: string;
      sql: string;
    }>;
  } {
    console.log(`[Database] Getting structure for table: ${tableName}`);
    
    // Get column information
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;
    
    // Get foreign key information
    const foreignKeys = this.db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
      match: string;
    }>;
    
    // Get indexes
    const indexes = this.db.prepare(`
      SELECT name, tbl_name, sql 
      FROM sqlite_master 
      WHERE type = 'index' AND tbl_name = ?
    `).all(tableName) as Array<{
      name: string;
      tbl_name: string;
      sql: string;
    }>;
    
    return { columns, foreignKeys, indexes };
  }

  // UI State operations
  getUIState(key: string): string | undefined {
    const result = this.db.prepare('SELECT value FROM ui_state WHERE key = ?').get(key) as { value: string } | undefined;
    return result?.value;
  }

  setUIState(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO ui_state (key, value, updated_at) 
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  }

  deleteUIState(key: string): void {
    this.db.prepare('DELETE FROM ui_state WHERE key = ?').run(key);
  }

  // App opens operations
  recordAppOpen(welcomeHidden: boolean, discordShown: boolean = false, appVersion?: string): void {
    this.db.prepare(`
      INSERT INTO app_opens (welcome_hidden, discord_shown, app_version)
      VALUES (?, ?, ?)
    `).run(welcomeHidden ? 1 : 0, discordShown ? 1 : 0, appVersion || null);
  }

  getLastAppOpen(): { opened_at: string; welcome_hidden: boolean; discord_shown: boolean; app_version?: string } | null {
    const result = this.db.prepare(`
      SELECT opened_at, welcome_hidden, discord_shown, app_version
      FROM app_opens
      ORDER BY opened_at DESC
      LIMIT 1
    `).get() as { opened_at: string; welcome_hidden: number; discord_shown: number; app_version?: string } | undefined;

    if (!result) return null;

    return {
      opened_at: result.opened_at,
      welcome_hidden: Boolean(result.welcome_hidden),
      discord_shown: Boolean(result.discord_shown),
      app_version: result.app_version
    };
  }

  getLastAppVersion(): string | null {
    const result = this.db.prepare(`
      SELECT app_version
      FROM app_opens
      WHERE app_version IS NOT NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `).get() as { app_version: string } | undefined;

    return result?.app_version || null;
  }

  updateLastAppOpenDiscordShown(): void {
    this.db.prepare(`
      UPDATE app_opens
      SET discord_shown = 1
      WHERE id = (SELECT id FROM app_opens ORDER BY opened_at DESC LIMIT 1)
    `).run();
  }

  // User preferences operations
  getUserPreference(key: string): string | null {
    const result = this.db.prepare(`
      SELECT value FROM user_preferences WHERE key = ?
    `).get(key) as { value: string } | undefined;
    
    return result?.value || null;
  }

  setUserPreference(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO user_preferences (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  }

  getUserPreferences(): Record<string, string> {
    const rows = this.db.prepare(`
      SELECT key, value FROM user_preferences
    `).all() as Array<{ key: string; value: string }>;
    
    const preferences: Record<string, string> = {};
    for (const row of rows) {
      preferences[row.key] = row.value;
    }
    return preferences;
  }

  // Panel operations
  createPanel(data: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    state?: unknown;
    metadata?: unknown;
  }): void {
    this.transaction(() => {
      const stateJson = data.state ? JSON.stringify(data.state) : null;
      const metadataJson = data.metadata ? JSON.stringify(data.metadata) : null;
      
      this.db.prepare(`
        INSERT INTO tool_panels (id, session_id, type, title, state, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(data.id, data.sessionId, data.type, data.title, stateJson, metadataJson);
    });
  }

  updatePanel(panelId: string, updates: {
    title?: string;
    state?: unknown;
    metadata?: unknown;
  }): void {
    // Get existing panel first to merge state
    const existingPanel = this.getPanel(panelId);

    this.transaction(() => {
      const setClauses: string[] = [];
      const values: (string | number | boolean | null)[] = [];

      if (updates.title !== undefined) {
        setClauses.push('title = ?');
        values.push(updates.title);
      }

      if (updates.state !== undefined) {
        // Merge with existing state instead of replacing
        const existingState = existingPanel?.state || {};
        const mergedState = {
          ...existingState,
          ...updates.state
        };

        // If there's a customState in either, merge that too
        if (typeof existingState === 'object' && existingState !== null && 'customState' in existingState) {
          const existingCustomState = (existingState as { customState?: unknown }).customState;
          const updatesCustomState = typeof updates.state === 'object' && updates.state !== null && 'customState' in updates.state
            ? (updates.state as { customState?: unknown }).customState
            : undefined;

          if (existingCustomState !== undefined || updatesCustomState !== undefined) {
            (mergedState as { customState: unknown }).customState = {
              ...(typeof existingCustomState === 'object' && existingCustomState !== null ? existingCustomState : {}),
              ...(typeof updatesCustomState === 'object' && updatesCustomState !== null ? updatesCustomState : {})
            };
          }
        }

        setClauses.push('state = ?');
        values.push(JSON.stringify(mergedState));
      }

      if (updates.metadata !== undefined) {
        setClauses.push('metadata = ?');
        values.push(JSON.stringify(updates.metadata));
      }

      if (setClauses.length > 0) {
        setClauses.push('updated_at = CURRENT_TIMESTAMP');
        values.push(panelId);

        this.db.prepare(`
          UPDATE tool_panels
          SET ${setClauses.join(', ')}
          WHERE id = ?
        `).run(...values);
      }
    });
  }

  deletePanel(panelId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM tool_panels WHERE id = ?').run(panelId);
    });
  }

  /**
   * Create a panel and set it as the active panel for the session in a single transaction
   */
  createPanelAndSetActive(data: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    state?: unknown;
    metadata?: unknown;
  }): void {
    this.transaction(() => {
      // Create the panel
      const stateJson = data.state ? JSON.stringify(data.state) : null;
      const metadataJson = data.metadata ? JSON.stringify(data.metadata) : null;
      
      this.db.prepare(`
        INSERT INTO tool_panels (id, session_id, type, title, state, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(data.id, data.sessionId, data.type, data.title, stateJson, metadataJson);

      // Set as active panel
      this.db.prepare('UPDATE sessions SET active_panel_id = ? WHERE id = ?').run(data.id, data.sessionId);
    });
  }

  getPanel(panelId: string): ToolPanel | null {
    const row = this.db.prepare('SELECT * FROM tool_panels WHERE id = ?').get(panelId) as ToolPanelRow | undefined;
    
    if (!row) return null;
    
    // Check if this panel is the active one for its session
    const activePanel = this.db.prepare('SELECT active_panel_id FROM sessions WHERE id = ?').get(row.session_id) as { active_panel_id: string | null } | undefined;
    const isActive = activePanel?.active_panel_id === panelId;
    
    const state = row.state ? JSON.parse(row.state) as ToolPanelState : { isActive: false, hasBeenViewed: false, customState: {} };
    // Update isActive based on whether this panel is the active one
    state.isActive = isActive;
    
    return {
      id: row.id,
      sessionId: row.session_id,
      type: row.type as ToolPanelType,
      title: row.title,
      state,
      metadata: row.metadata ? JSON.parse(row.metadata) as ToolPanelMetadata : { createdAt: row.created_at, lastActiveAt: row.created_at, position: 0 }
    };
  }

  getPanelsForSession(sessionId: string): ToolPanel[] {
    const rows = this.db.prepare('SELECT * FROM tool_panels WHERE session_id = ? ORDER BY created_at').all(sessionId) as ToolPanelRow[];
    
    // Get the active panel ID for this session
    const activePanel = this.db.prepare('SELECT active_panel_id FROM sessions WHERE id = ?').get(sessionId) as { active_panel_id: string | null } | undefined;
    const activePanelId = activePanel?.active_panel_id;
    
    return rows.map(row => {
      const state = row.state ? JSON.parse(row.state) as ToolPanelState : { isActive: false, hasBeenViewed: false, customState: {} };
      // Update isActive based on whether this panel is the active one
      state.isActive = row.id === activePanelId;
      
      return {
        id: row.id,
        sessionId: row.session_id,
        type: row.type as ToolPanelType,
        title: row.title,
        state,
        metadata: row.metadata ? JSON.parse(row.metadata) as ToolPanelMetadata : { createdAt: row.created_at, lastActiveAt: row.created_at, position: 0 }
      };
    });
  }

  getAllPanels(): ToolPanel[] {
    const rows = this.db.prepare('SELECT * FROM tool_panels ORDER BY created_at').all() as ToolPanelRow[];
    
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type as ToolPanelType,
      title: row.title,
      state: row.state ? JSON.parse(row.state) as ToolPanelState : { isActive: false },
      metadata: row.metadata ? JSON.parse(row.metadata) as ToolPanelMetadata : { createdAt: row.created_at, lastActiveAt: row.created_at, position: 0 }
    }));
  }

  getActivePanels(): ToolPanel[] {
    const rows = this.db.prepare(`
      SELECT tp.* FROM tool_panels tp
      JOIN sessions s ON tp.session_id = s.id
      WHERE s.archived = 0 OR s.archived IS NULL
      ORDER BY tp.created_at
    `).all() as ToolPanelRow[];
    
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type as ToolPanelType,
      title: row.title,
      state: row.state ? JSON.parse(row.state) as ToolPanelState : { isActive: false },
      metadata: row.metadata ? JSON.parse(row.metadata) as ToolPanelMetadata : { createdAt: row.created_at, lastActiveAt: row.created_at, position: 0 }
    }));
  }

  setActivePanel(sessionId: string, panelId: string | null): void {
    this.db.prepare('UPDATE sessions SET active_panel_id = ? WHERE id = ?').run(panelId, sessionId);
  }

  getActivePanel(sessionId: string): ToolPanel | null {
    const row = this.db.prepare(`
      SELECT tp.* FROM tool_panels tp
      JOIN sessions s ON s.active_panel_id = tp.id
      WHERE s.id = ?
    `).get(sessionId) as ToolPanelRow | undefined;
    
    if (!row) return null;
    
    const state = row.state ? JSON.parse(row.state) as ToolPanelState : { isActive: true, hasBeenViewed: false };
    // This panel is the active one by definition (we joined on active_panel_id)
    state.isActive = true;
    
    return {
      id: row.id,
      sessionId: row.session_id,
      type: row.type as ToolPanelType,
      title: row.title,
      state,
      metadata: row.metadata ? JSON.parse(row.metadata) as ToolPanelMetadata : { createdAt: row.created_at, lastActiveAt: row.created_at, position: 0 }
    };
  }

  deletePanelsForSession(sessionId: string): void {
    this.db.prepare('DELETE FROM tool_panels WHERE session_id = ?').run(sessionId);
  }

  // ========== UNIFIED PANEL SETTINGS OPERATIONS ==========
  // These methods store all panel-specific settings as JSON in the tool_panels.settings column
  // This provides a flexible, extensible way to store settings without schema changes

  /**
   * Get panel settings from the unified JSON storage
   * Returns the parsed settings object or an empty object if none exist
   */
  getPanelSettings(panelId: string): Record<string, unknown> {
    const row = this.db.prepare(`
      SELECT settings FROM tool_panels WHERE id = ?
    `).get(panelId) as { settings?: string } | undefined;

    if (!row || !row.settings) {
      return {};
    }

    try {
      return JSON.parse(row.settings);
    } catch (e) {
      console.error(`Failed to parse settings for panel ${panelId}:`, e);
      return {};
    }
  }

  /**
   * Update panel settings in the unified JSON storage
   * Merges the provided settings with existing ones
   */
  updatePanelSettings(panelId: string, settings: Record<string, unknown>): void {
    // Get existing settings
    const existingSettings = this.getPanelSettings(panelId);
    
    // Merge with new settings
    const mergedSettings = {
      ...existingSettings,
      ...settings,
      updatedAt: new Date().toISOString()
    };

    // Update the database
    this.db.prepare(`
      UPDATE tool_panels
      SET settings = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(mergedSettings), panelId);
  }

  /**
   * Set panel settings (replaces all existing settings)
   */
  setPanelSettings(panelId: string, settings: Record<string, unknown>): void {
    const settingsWithTimestamp = {
      ...settings,
      updatedAt: new Date().toISOString()
    };

    this.db.prepare(`
      UPDATE tool_panels
      SET settings = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(settingsWithTimestamp), panelId);
  }

  // ========== LEGACY CLAUDE PANEL SETTINGS (for backward compatibility) ==========
  // These will be deprecated but are kept for migration purposes

  createClaudePanelSettings(panelId: string, settings: {
    model?: string;
    commit_mode?: boolean;
    system_prompt?: string;
    max_tokens?: number;
    temperature?: number;
  }): void {
    // Use the new unified settings storage
    this.updatePanelSettings(panelId, {
      model: settings.model || 'auto',
      commitMode: settings.commit_mode || false,
      systemPrompt: settings.system_prompt || null,
      maxTokens: settings.max_tokens || 4096,
      temperature: settings.temperature || 0.7
    });
  }

  getClaudePanelSettings(panelId: string): {
    panel_id: string;
    model: string;
    commit_mode: boolean;
    system_prompt: string | null;
    max_tokens: number;
    temperature: number;
    created_at: string;
    updated_at: string;
  } | null {
    const settings = this.getPanelSettings(panelId);
    
    if (!settings || Object.keys(settings).length === 0) {
      return null;
    }

    // Convert from new format to old format for compatibility
    const s = settings as Record<string, unknown>;
    return {
      panel_id: panelId,
      model: (typeof s.model === 'string' ? s.model : null) || 'auto',
      commit_mode: (typeof s.commitMode === 'boolean' ? s.commitMode : null) || false,
      system_prompt: (typeof s.systemPrompt === 'string' ? s.systemPrompt : null) || null,
      max_tokens: (typeof s.maxTokens === 'number' ? s.maxTokens : null) || 4096,
      temperature: (typeof s.temperature === 'number' ? s.temperature : null) || 0.7,
      created_at: (typeof s.createdAt === 'string' ? s.createdAt : null) || new Date().toISOString(),
      updated_at: (typeof s.updatedAt === 'string' ? s.updatedAt : null) || new Date().toISOString()
    };
  }

  updateClaudePanelSettings(panelId: string, settings: {
    model?: string;
    commit_mode?: boolean;
    system_prompt?: string;
    max_tokens?: number;
    temperature?: number;
  }): void {
    const updateObj: Record<string, unknown> = {};
    
    if (settings.model !== undefined) updateObj.model = settings.model;
    if (settings.commit_mode !== undefined) updateObj.commitMode = settings.commit_mode;
    if (settings.system_prompt !== undefined) updateObj.systemPrompt = settings.system_prompt;
    if (settings.max_tokens !== undefined) updateObj.maxTokens = settings.max_tokens;
    if (settings.temperature !== undefined) updateObj.temperature = settings.temperature;
    
    this.updatePanelSettings(panelId, updateObj);
  }

  deleteClaudePanelSettings(panelId: string): void {
    this.db.prepare('DELETE FROM claude_panel_settings WHERE panel_id = ?').run(panelId);
  }

  // Session statistics methods
  getSessionTokenUsage(sessionId: string): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
    messageCount: number;
  } {
    const rows = this.db.prepare(`
      SELECT data 
      FROM session_outputs 
      WHERE session_id = ? AND type = 'json'
      ORDER BY timestamp ASC
    `).all(sessionId) as { data: string }[];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let messageCount = 0;

    rows.forEach((row: { data: string }) => {
      try {
        const data = JSON.parse(row.data);
        if (data.input_tokens) {
          totalInputTokens += data.input_tokens;
          messageCount++;
        }
        if (data.output_tokens) {
          totalOutputTokens += data.output_tokens;
        }
        if (data.cache_read_input_tokens) {
          totalCacheReadTokens += data.cache_read_input_tokens;
        }
        if (data.cache_creation_input_tokens) {
          totalCacheCreationTokens += data.cache_creation_input_tokens;
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      messageCount
    };
  }

  getSessionOutputCounts(sessionId: string): { json: number; stdout: number; stderr: number } {
    const result = this.db.prepare(`
      SELECT 
        type,
        COUNT(*) as count
      FROM session_outputs
      WHERE session_id = ?
      GROUP BY type
    `).all(sessionId) as { type: string; count: number }[];

    const counts: { json: number; stdout: number; stderr: number } = {
      json: 0,
      stdout: 0,
      stderr: 0
    };

    result.forEach((row: { type: string; count: number }) => {
      if (row.type in counts) {
        counts[row.type as keyof typeof counts] = row.count;
      }
    });

    return counts;
  }

  getConversationMessageCount(sessionId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM conversation_messages 
      WHERE session_id = ?
    `).get(sessionId) as { count: number } | undefined;
    
    return result?.count || 0;
  }

  getPanelConversationMessageCount(panelId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count 
      FROM conversation_messages 
      WHERE panel_id = ?
    `).get(panelId) as { count: number } | undefined;
    
    return result?.count || 0;
  }

  getSessionToolUsage(sessionId: string): {
    tools: Array<{
      name: string;
      count: number;
      totalDuration: number;
      avgDuration: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    }>;
    totalToolCalls: number;
  } {
    // Get all tool_use messages for this session
    const toolUseRows = this.db.prepare(`
      SELECT data, timestamp 
      FROM session_outputs 
      WHERE session_id = ? AND type = 'json'
      ORDER BY timestamp ASC
    `).all(sessionId) as { data: string; timestamp: string }[];

    const toolStats = new Map<string, {
      count: number;
      durations: number[];
      inputTokens: number;
      outputTokens: number;
      lastCallTime?: string;
      pendingCalls: Map<string, string>;
    }>();

    let totalToolCalls = 0;

    // Process each message
    toolUseRows.forEach((row: { data: string; timestamp: string }, index: number) => {
      try {
        const data = JSON.parse(row.data);
        
        // Check if this is a tool_use message
        if (data.type === 'assistant' && data.message?.content) {
          data.message.content.forEach((content: unknown) => {
            const contentObj = content as { type?: string; name?: string; id?: string };
            if (contentObj.type === 'tool_use' && contentObj.name) {
              totalToolCalls++;
              const toolName = contentObj.name!;
              const toolId = contentObj.id;
              
              if (!toolStats.has(toolName)) {
                toolStats.set(toolName, {
                  count: 0,
                  durations: [],
                  inputTokens: 0,
                  outputTokens: 0,
                  pendingCalls: new Map()
                });
              }
              
              const stats = toolStats.get(toolName)!;
              stats.count++;
              if (toolId) {
                stats.pendingCalls.set(toolId, row.timestamp);
              }
              
              // Add token usage if available
              if (data.message.usage) {
                stats.inputTokens += data.message.usage.input_tokens || 0;
                stats.outputTokens += data.message.usage.output_tokens || 0;
              }
            }
          });
        }
        
        // Check if this is a tool_result message
        if (data.type === 'user' && data.message?.content) {
          data.message.content.forEach((content: unknown) => {
            const contentObj = content as { type?: string; tool_use_id?: string };
            if (contentObj.type === 'tool_result' && contentObj.tool_use_id) {
              // Find which tool this result belongs to
              for (const [toolName, stats] of toolStats.entries()) {
                if (stats.pendingCalls.has(contentObj.tool_use_id)) {
                  const startTime = stats.pendingCalls.get(contentObj.tool_use_id)!;
                  stats.pendingCalls.delete(contentObj.tool_use_id);
                  
                  // Calculate duration in milliseconds
                  const start = new Date(startTime).getTime();
                  const end = new Date(row.timestamp).getTime();
                  let duration = end - start;
                  
                  // If duration is 0 (same second), estimate based on tool type
                  // These are typical execution times in milliseconds
                  if (duration === 0) {
                    const estimatedDurations: Record<string, number> = {
                      'Read': 150,
                      'Write': 200,
                      'Edit': 250,
                      'MultiEdit': 400,
                      'Grep': 100,
                      'Glob': 80,
                      'LS': 50,
                      'Bash': 500,
                      'BashOutput': 30,
                      'KillBash': 50,
                      'Task': 1000,
                      'TodoWrite': 100,
                      'WebSearch': 2000,
                      'WebFetch': 1500,
                    };
                    duration = estimatedDurations[toolName] || 100; // Default 100ms for unknown tools
                  }
                  
                  if (duration >= 0 && duration < 3600000) { // Ignore durations > 1 hour (likely errors)
                    stats.durations.push(duration);
                  }
                  break;
                }
              }
            }
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    });

    // Convert map to array with calculated averages
    const tools = Array.from(toolStats.entries()).map(([name, stats]) => ({
      name,
      count: stats.count,
      totalDuration: stats.durations.reduce((sum, d) => sum + d, 0),
      avgDuration: stats.durations.length > 0 
        ? stats.durations.reduce((sum, d) => sum + d, 0) / stats.durations.length
        : 0,
      totalInputTokens: stats.inputTokens,
      totalOutputTokens: stats.outputTokens
    })).sort((a, b) => b.count - a.count); // Sort by usage count

    return {
      tools,
      totalToolCalls
    };
  }

  close(): void {
    this.db.close();
  }
}

// Export singleton instance
// Note: This is initialized in src/index.ts with the proper database path
export let databaseService: DatabaseService;

export function initializeDatabaseService(dbPath: string): DatabaseService {
  databaseService = new DatabaseService(dbPath);
  return databaseService;
}

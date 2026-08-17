import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Session, Prompt, McpServerConfig, AppSettings, Skill } from './types';

interface AppDB extends DBSchema {
  sessions: {
    key: string;
    value: Session;
    indexes: { 'updatedAt': number };
  };
  prompts: {
    key: string;
    value: Prompt;
  };
  skills: {
    key: string;
    value: Skill;
  };
  mcpServers: {
    key: string;
    value: McpServerConfig;
  };
  settings: {
    key: string;
    value: AppSettings;
  };
}

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

function getDB() {
  if (typeof window === 'undefined') return null; // Don't open DB on server
  if (!dbPromise) {
    dbPromise = openDB<AppDB>('ai-workspace', 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('sessions')) {
          const store = db.createObjectStore('sessions', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('prompts')) {
          db.createObjectStore('prompts', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('skills')) {
          db.createObjectStore('skills', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('mcpServers')) {
          db.createObjectStore('mcpServers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function getSessions(): Promise<Session[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAllFromIndex('sessions', 'updatedAt');
}

export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDB();
  if (!db) return undefined;
  return db.get('sessions', id);
}

export async function saveSession(session: Session): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('sessions', session);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.delete('sessions', id);
}

export async function getPrompts(): Promise<Prompt[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('prompts');
}

export async function savePrompt(prompt: Prompt): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('prompts', prompt);
}

export async function getSkills(): Promise<Skill[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('skills');
}

export async function saveSkill(skill: Skill): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('skills', skill);
}

export async function deleteSkill(id: string): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.delete('skills', id);
}

export async function getMcpServers(): Promise<McpServerConfig[]> {
  const db = await getDB();
  if (!db) return [];
  return db.getAll('mcpServers');
}

export async function saveMcpServer(server: McpServerConfig): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('mcpServers', server);
}

export async function getSettings(): Promise<AppSettings | undefined> {
  const db = await getDB();
  if (!db) return undefined;
  return db.get('settings', 'default');
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDB();
  if (!db) return;
  await db.put('settings', settings);
}

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');

// Initialize database if it doesn't exist
async function initDb() {
  try {
    await fs.access(DB_PATH);
  } catch {
    const defaultData = { users: [] };
    await fs.writeFile(DB_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
}

// Read JSON database helper
async function readDb() {
  await initDb();
  const data = await fs.readFile(DB_PATH, 'utf-8');
  return JSON.parse(data);
}

// Write JSON database helper safely using tmp file
async function writeDb(data) {
  const tempPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tempPath, DB_PATH);
}

// Safe password hashing using PBKDF2 (native Node.js, no binary packages needed)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Password verification
function verifyPassword(password, storedPassword) {
  if (!storedPassword || !storedPassword.includes(':')) {
    return false;
  }
  const [salt, hash] = storedPassword.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

const db = {
  getUser: async (email) => {
    if (!email) return null;
    const data = await readDb();
    return data.users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
  },

  createUser: async (email, password) => {
    if (!email || !password) throw new Error('Email and password required');
    const data = await readDb();
    if (data.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('User already exists');
    }
    const newUser = {
      email: email.toLowerCase(),
      passwordHash: hashPassword(password),
      samples: [],
      onboardingComplete: false,
      postsGenerated: 0,
      history: [],
      linkedinAccessToken: "",
      linkedinPersonUrn: "",
      publishedPosts: []
    };
    data.users.push(newUser);
    await writeDb(data);
    return newUser;
  },

  updateUser: async (email, updates) => {
    if (!email) throw new Error('Email is required');
    const data = await readDb();
    const idx = data.users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
    if (idx === -1) throw new Error('User not found');

    // Filter out passwordHash updates to prevent overwriting without hashing
    const { passwordHash, ...safeUpdates } = updates;

    data.users[idx] = { ...data.users[idx], ...safeUpdates };
    await writeDb(data);
    return data.users[idx];
  },

  verifyCredentials: async (email, password) => {
    if (!email || !password) return null;
    const user = await db.getUser(email);
    if (!user) return null;
    const isValid = verifyPassword(password, user.passwordHash);
    return isValid ? user : null;
  }
};

module.exports = db;

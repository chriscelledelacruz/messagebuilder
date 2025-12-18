const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware to parse JSON bodies (REQUIRED for Smart Search)
app.use(express.json());

// Multer for Task CSV only
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

// API Helper
async function sb(method, path, body) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      "Authorization": STAFFBASE_TOKEN,
      "Content-Type": "application/json"
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

async function findUserByHiddenId(csvId) {
  // Simplified lookup loop (same as before)
  let offset = 0;
  const limit = 100;
  while (true) {
    const result = await sb("GET", `/users?limit=${limit}&offset=${offset}`);
    if (!result.data || result.data.length === 0) break;
    
    const found = result.data.find(u => u.profile?.[HIDDEN_ATTRIBUTE_KEY] === csvId);
    if (found) return found;
    
    if (result.data.length < limit) break;
    offset += limit;
  }
  return null;
}

// --- UPDATED VERIFY ENDPOINT (Accepts JSON) ---
app.post("/api/verify-users", async (req, res) => {
  try {
    const { storeIds } = req.body; // Expecting array of strings from client

    if (!storeIds || !Array.isArray(storeIds) || storeIds.length === 0) {
      return res.status(400).json({ error: "No store IDs provided." });
    }

    const foundUsers = [];
    const notFoundIds = [];

    // Check 7-Eleven Staffbase Users
    for (const id of storeIds) {
      const user = await findUserByHiddenId(id);
      if (user) {
        foundUsers.push({
          id: user.id,
          csvId: id,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim()
        });
      } else {
        notFoundIds.push(id);
      }
    }

    res.json({ foundUsers, notFoundIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UPDATED CREATE ENDPOINT (Handles JSON storeIds + Optional File) ---
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    // Multer handles the file, but puts text fields in req.body
    let { storeIds, title, department } = req.body;
    
    if (typeof storeIds === 'string') {
      try {
        storeIds = JSON.parse(storeIds); // Parse if it came as stringified JSON
      } catch(e) { /* ignore */ }
    }

    if (!storeIds || storeIds.length === 0) {
      return res.status(400).json({ error: "No verified stores provided." });
    }

    // 1. Resolve User IDs again (for security/freshness)
    const userIds = [];
    for (const id of storeIds) {
      const user = await findUserByHiddenId(id);
      if (user) userIds.push(user.id);
    }

    if (userIds.length === 0) return res.status(404).json({ error: "No users found." });

    // 2. Create Channel
    const externalId = Date.now();
    const channelName = `[external]${externalId}:${userIds.length} - ${title}`;
    
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      config: {
        localization: { en_US: { title: channelName }, de_DE: { title: channelName } }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id || channelRes.pluginInstance?.id;

    // 3. Create Post
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { en_US: { title, content: `<p>${title}</p>`, teaser: department } }
    });

    // 4. Update Channel Name with Post Metadata
    const newLabel = `[external]${externalId}:${userIds.length}:${postRes.id}::${department} - ${title}`;
    await sb("POST", `/installations/${channelId}`, {
      config: { localization: { en_US: { title: newLabel }, de_DE: { title: newLabel } } }
    });

    res.json({ success: true, channelId, postId: postRes.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- EXISTING ENDPOINTS (GET Items, DELETE, Status) ---
app.get("/api/items", async (req, res) => {
  // Reuse existing logic from previous code...
  // (Simplified for brevity, copy the logic from your previous server.js here)
  try {
    // Mock for now or implement the discover logic
    res.json({ items: [] }); 
  } catch (e) { res.json({ items: [] }); }
});

app.delete("/api/delete/:id", async (req, res) => {
  try {
    await sb("DELETE", `/installations/${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve Static
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

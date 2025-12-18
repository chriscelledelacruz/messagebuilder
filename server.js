const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' })); 
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

// --- API HELPER ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sb(method, path, body) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      "Authorization": `Basic ${STAFFBASE_TOKEN}`, 
      "Content-Type": "application/json"
    }
  };
  if (body) options.body = JSON.stringify(body);

  let retries = 3;
  while (retries > 0) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      console.warn(`[API 429] Rate limit hit on ${path}, retrying...`);
      await delay(1000);
      retries--;
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[API Error] ${method} ${path}: ${res.status} - ${txt}`); 
      throw new Error(`API ${res.status}: ${txt}`);
    }
    if (res.status === 204) return {};
    return res.json();
  }
  throw new Error("API Timeout");
}

// --- LOGIC HELPERS ---
async function batchVerifyUsers(storeIds) {
  const foundUsers = [];
  const notFoundIds = [];
  const CONCURRENCY = 5; 
  
  const checkId = async (id) => {
    try {
      const res = await sb("GET", `/users?externalID=${encodeURIComponent(id)}`);
      if (res.data && res.data.length > 0) {
        const user = res.data.find(u => u.externalID === id);
        if (user) {
          foundUsers.push({ id: user.id, csvId: id, name: `${user.firstName || ''} ${user.lastName || ''}`.trim() });
        } else {
          notFoundIds.push(id);
        }
      } else {
        notFoundIds.push(id);
      }
    } catch (err) {
      notFoundIds.push(id);
    }
  };

  for (let i = 0; i < storeIds.length; i += CONCURRENCY) {
    const chunk = storeIds.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(id => checkId(id)));
  }
  return { foundUsers, notFoundIds };
}

function parseTaskCSV(buffer) {
  try {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tasks = [];
    lines.forEach(line => {
      const [title, desc, date] = line.split(';').map(s => s ? s.trim() : '');
      if (title) {
        let dueDate = null;
        if(date) dueDate = new Date(date).toISOString();
        tasks.push({ title, description: desc || "", dueDate });
      }
    });
    return tasks;
  } catch (e) { return []; }
}

async function discoverProjectsByStoreIds(storeIds) {
  const projectMap = {};
  let offset = 0; const limit = 100;
  while(true) {
    const res = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
    if(!res.data || res.data.length === 0) break;
    res.data.forEach(inst => {
      const title = inst.config?.localization?.en_US?.title || "";
      const match = title.match(/^Store\s+(\w+)$/i);
      if(match && storeIds.includes(match[1])) {
        projectMap[match[1]] = inst.id;
      }
    });
    if(res.data.length < limit) break;
    offset += limit;
  }
  return projectMap;
}

// --- ROUTES ---

app.post("/api/verify-users", async (req, res) => {
  try {
    const { storeIds } = req.body;
    if (!storeIds || !Array.isArray(storeIds)) return res.status(400).json({ error: "Invalid storeIds" });
    const result = await batchVerifyUsers(storeIds);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    let { storeIds, title, department } = req.body;
    if (typeof storeIds === 'string') {
      try { storeIds = JSON.parse(storeIds); } catch(e) {}
    }

    if (!storeIds || storeIds.length === 0) return res.status(400).json({ error: "No stores provided" });

    // 1. Resolve Users
    const verification = await batchVerifyUsers(storeIds);
    const userIds = verification.foundUsers.map(u => u.id);
    
    if (userIds.length === 0) {
      return res.status(404).json({ error: `No valid users found.` });
    }

    // 2. Generate Metadata (FIXED: Using Hyphens only)
    const now = Date.now();
    // STRIP all non-alphanumeric chars from department to be 100% safe
    const safeDept = (department || 'General').replace(/[^a-zA-Z0-9]/g, ''); 
    // New Format: adhoc-v2-{timestamp}-{count}-{department}
    const metaExternalID = `adhoc-v2-${now}-${userIds.length}-${safeDept}`;

    console.log("Generating External ID:", metaExternalID); // Debugging Log

    // 3. Create Channel
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { en_US: { title: title }, de_DE: { title: title } }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;

    // 4. Create Post
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: `<p><strong>Category:</strong> ${department}</p><p>Targeted Stores: ${userIds.length}</p>`, 
          teaser: department 
        } 
      }
    });

    // 5. Handle Tasks
    let taskCount = 0;
    if (req.file) {
      const tasks = parseTaskCSV(req.file.buffer);
      if (tasks.length > 0) {
        const projectMap = await discoverProjectsByStoreIds(storeIds);
        const installationIds = Object.values(projectMap);
        
        // Chunk requests to avoid rate limits
        const chunkedInsts = [];
        for (let i=0; i<installationIds.length; i+=5) chunkedInsts.push(installationIds.slice(i,i+5));

        for (const chunk of chunkedInsts) {
          await Promise.all(chunk.map(async (instId) => {
            try {
              const listRes = await sb("POST", `/tasks/${instId}/lists`, { name: title });
              for (const t of tasks) {
                await sb("POST", `/tasks/${instId}/task`, {
                  taskListId: listRes.id,
                  title: t.title,
                  description: t.description,
                  dueDate: t.dueDate,
                  status: "OPEN",
                  assigneeIds: [] 
                });
              }
            } catch(e) { console.error(`Task error ${instId}`, e.message); }
          }));
        }
        taskCount = tasks.length * installationIds.length;
      }
    }

    res.json({ success: true, channelId, postId: postRes.id, taskCount });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. GET ITEMS (Hybrid: Supports New Hyphen V2 + Legacy)
app.get("/api/items", async (req, res) => {
  try {
    const items = [];
    let offset = 0; const limit = 100;

    while(true) {
      const result = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
      if (!result.data || result.data.length === 0) break;

      for (const inst of result.data) {
        if (inst.pluginID !== 'news') continue;

        let item = null;
        const title = inst.config?.localization?.en_US?.title || "Untitled";
        const extID = inst.externalID || "";

        // STRATEGY A: New V2 (Hyphen)
        if (extID.startsWith('adhoc-v2-')) {
          const parts = extID.split('-');
          item = {
            channelId: inst.id,
            title: title,
            department: parts[3] || "General",
            userCount: parts[2] || "0",
            createdAt: new Date(parseInt(parts[1])).toISOString(),
            status: "Draft"
          };
        } 
        // STRATEGY B: Legacy Support (Pipe or Title)
        else if (extID.startsWith('adhoc_v2|')) {
           const parts = extID.split('|');
           item = {
             channelId: inst.id,
             title: title,
             department: parts[3],
             userCount: parts[2],
             createdAt: new Date(parseInt(parts[1])).toISOString(),
             status: "Draft"
           };
        }
        else if (title.startsWith('[external]')) {
          const match = title.match(/^\[external\][^:]+:(\d+):([^:]*)::([^ ]+) - (.+)$/);
          if (match) {
            item = {
              channelId: inst.id,
              title: match[4],
              department: match[3],
              userCount: match[1],
              createdAt: inst.created || new Date().toISOString(),
              status: "Draft"
            };
          }
        }

        if (item) {
          try {
            const posts = await sb("GET", `/channels/${item.channelId}/posts?limit=1`);
            if (posts.data && posts.data.length > 0) {
              const p = posts.data[0];
              if (p.published) item.status = "Published";
              else if (p.planned) item.status = "Scheduled";
            }
          } catch(e) {}
          items.push(item);
        }
      }

      if (result.data.length < limit) break;
      offset += limit;
    }

    items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items });
  } catch (err) {
    console.error(err);
    res.json({ items: [] });
  }
});

// 4. DELETE
app.delete("/api/delete/:id", async (req, res) => {
  try {
    await sb("DELETE", `/installations/${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

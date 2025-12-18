const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' })); 
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

// --- API HELPER (With Robust Rate Limiting) ---
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

  let retries = 5;
  while (retries > 0) {
    const res = await fetch(url, options);
    
    if (res.status === 429) {
      console.warn(`[API 429] Too many requests. Waiting 2s...`);
      await delay(2000);
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
  throw new Error("API Timeout after multiple retries");
}

// --- OPTIMIZED LOOKUP: FETCH ALL & MAP ---
// This is the only way to search by Custom Attributes efficiently.
// It fetches all users (13k ≈ 130 pages) and builds a map.
async function getAllUsersMap() {
  const userMap = new Map(); // Key: StoreID, Value: UserObject
  let offset = 0;
  const limit = 100;
  
  console.log("Fetching full user directory...");
  
  while (true) {
    try {
      const res = await sb("GET", `/users?limit=${limit}&offset=${offset}`);
      if (!res.data || res.data.length === 0) break;

      for (const user of res.data) {
        // key is the Value inside the Custom Attribute (e.g. "51362")
        // If HIDDEN_ATTRIBUTE_KEY is not set, it might fall back to something else, so ensure .env is correct.
        const storeId = user.profile?.[HIDDEN_ATTRIBUTE_KEY];
        if (storeId) {
          userMap.set(String(storeId), {
            id: user.id,
            csvId: String(storeId),
            name: `${user.firstName || ''} ${user.lastName || ''}`.trim()
          });
        }
      }

      if (res.data.length < limit) break;
      offset += limit;
      
      // Small safety delay to be nice to the API
      if (offset % 1000 === 0) await delay(200); 

    } catch (e) {
      console.error("Error fetching page:", e.message);
      break;
    }
  }
  
  console.log(`Directory loaded. Found ${userMap.size} users with store IDs.`);
  return userMap;
}

// --- HELPERS ---
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

// 1. VERIFY USERS (Now uses the Bulk Map strategy)
app.post("/api/verify-users", async (req, res) => {
  try {
    const { storeIds } = req.body;
    if (!storeIds || !Array.isArray(storeIds)) return res.status(400).json({ error: "Invalid storeIds" });

    // 1. Load the "Phonebook"
    const userMap = await getAllUsersMap();
    
    const foundUsers = [];
    const notFoundIds = [];

    // 2. Look up every ID in the phonebook (Instant)
    for (const id of storeIds) {
      const user = userMap.get(String(id));
      if (user) {
        foundUsers.push(user);
      } else {
        notFoundIds.push(id);
      }
    }

    res.json({ foundUsers, notFoundIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2. CREATE POST
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    let { verifiedUsers, title, department } = req.body;
    
    // Parse verifiedUsers from string if needed
    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    // Fallback: If verifying stores failed or wasn't done, we need to map them now.
    // This handles the "No valid users found" error if the frontend didn't pass the object correctly.
    if (!verifiedUsers || verifiedUsers.length === 0) {
       // If client sent raw storeIds instead of verified objects, try to resolve them
       let { storeIds } = req.body;
       if (typeof storeIds === 'string') try { storeIds = JSON.parse(storeIds); } catch(e) {}
       
       if (storeIds && storeIds.length > 0) {
         console.log("Resolving raw store IDs for creation...");
         const userMap = await getAllUsersMap();
         verifiedUsers = [];
         for(const id of storeIds) {
           const u = userMap.get(String(id));
           if(u) verifiedUsers.push(u);
         }
       }
    }

    if (!verifiedUsers || verifiedUsers.length === 0) {
      return res.status(400).json({ error: "No verified users found. Please verify stores first." });
    }

    // 1. Extract IDs
    const userIds = verifiedUsers.map(u => u.id); // Internal IDs
    const storeIds = verifiedUsers.map(u => u.csvId); // Store IDs

    // 2. Metadata (Using Hyphens - Safe)
    const now = Date.now();
    const safeDept = (department || 'General').replace(/[^a-zA-Z0-9]/g, ''); 
    const metaExternalID = `adhoc-v2-${now}-${userIds.length}-${safeDept}`;

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
        
        // Chunk requests
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

// 3. GET ITEMS
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
    res.json({ items: [] });
  }
});

app.delete("/api/delete/:id", async (req, res) => {
  try { await sb("DELETE", `/installations/${req.params.id}`); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

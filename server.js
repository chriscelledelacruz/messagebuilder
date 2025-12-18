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
      console.warn(`[API 429] Rate limit hit. Waiting 2s...`);
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
  throw new Error("API Timeout");
}

// --- LOGIC HELPERS ---
async function getAllUsersMap() {
  const userMap = new Map(); 
  let offset = 0;
  const limit = 100;
  
  console.log("Fetching full user directory...");
  
  while (true) {
    try {
      const res = await sb("GET", `/users?limit=${limit}&offset=${offset}`);
      if (!res.data || res.data.length === 0) break;

      for (const user of res.data) {
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
      if (offset % 1000 === 0) await delay(200); 

    } catch (e) {
      console.error("Error fetching page:", e.message);
      break;
    }
  }
  return userMap;
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

    const userMap = await getAllUsersMap();
    const foundUsers = [];
    const notFoundIds = [];

    for (const id of storeIds) {
      const user = userMap.get(String(id));
      if (user) foundUsers.push(user);
      else notFoundIds.push(id);
    }

    res.json({ foundUsers, notFoundIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    let { verifiedUsers, title, department } = req.body;
    
    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    // Fallback: Resolve if frontend sent raw IDs
    if (!verifiedUsers || verifiedUsers.length === 0) {
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
      return res.status(400).json({ error: "No verified users found." });
    }

    const userIds = verifiedUsers.map(u => u.id);
    const storeIds = verifiedUsers.map(u => u.csvId);

    // FIX: Use simple safe ID. Store metadata in the Post Content instead.
    const now = Date.now();
    const metaExternalID = `adhoc-${now}`; 

    console.log("Generating Safe External ID:", metaExternalID);

    // Create Channel
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { en_US: { title: title }, de_DE: { title: title } }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;

    // Create Post
    // We store the Department in the Teaser so we can find it later
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: `<p><strong>Category:</strong> ${department}</p><p>Targeted Stores: ${userIds.length}</p>`, 
          teaser: department 
        } 
      }
    });

    // Handle Tasks
    let taskCount = 0;
    if (req.file) {
      const tasks = parseTaskCSV(req.file.buffer);
      if (tasks.length > 0) {
        const projectMap = await discoverProjectsByStoreIds(storeIds);
        const installationIds = Object.values(projectMap);
        
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

// GET ITEMS (Updated to read safe format)
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

        // STRATEGY A: New "Safe" Format (adhoc-123456789)
        if (extID.startsWith('adhoc-') && !extID.includes('|') && !extID.includes('v2')) {
          // It's the new clean format. 
          // We get the date from 'created' and count from 'accessorIDs'
          // We get 'department' from the post (fetched below)
          item = {
            channelId: inst.id,
            title: title,
            department: "General", // Placeholder until post fetch
            userCount: inst.accessorIDs ? inst.accessorIDs.length : 0,
            createdAt: inst.created || new Date().toISOString(),
            status: "Draft"
          };
        }
        // STRATEGY B: Legacy Support (adhoc_v2... or [external]...)
        else if (extID.startsWith('adhoc_v2') || extID.startsWith('adhoc-v2')) {
           // Try to parse if possible, or fallback to safe defaults
           item = {
             channelId: inst.id,
             title: title,
             department: "Legacy",
             userCount: inst.accessorIDs ? inst.accessorIDs.length : 0,
             createdAt: inst.created,
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
              createdAt: inst.created,
              status: "Draft"
            };
          }
        }

        if (item) {
          try {
            const posts = await sb("GET", `/channels/${item.channelId}/posts?limit=1`);
            if (posts.data && posts.data.length > 0) {
              const p = posts.data[0];
              // FETCH DEPARTMENT from the Teaser if it's our new format
              if (item.department === "General" && p.contents?.en_US?.teaser) {
                item.department = p.contents.en_US.teaser; 
              }
              
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

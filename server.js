const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware
// Increased limit for large JSON payloads (thousands of IDs)
app.use(express.json({ limit: '50mb' })); 

// Multer Setup: We only accept 'taskCsv' now. 
// The Store list comes in the request body, not as a file.
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

// --- API HELPER (With Retry Logic) ---
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
    
    // Handle Rate Limiting
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
    
    // Handle Empty Responses (204)
    if (res.status === 204) return {};
    return res.json();
  }
  throw new Error("API Timeout after retries");
}

// --- LOGIC HELPERS ---

// Bulk Fetch User Map (The "Phonebook" Strategy)
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
        // We look for the Store ID in the custom profile field
        const storeId = user.profile?.[HIDDEN_ATTRIBUTE_KEY];
        if (storeId) {
          // Map Store ID -> User Object
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

// Parse Task CSV (Buffer -> Array)
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

// Find Store Projects (e.g., "Store 1001")
async function discoverProjectsByStoreIds(storeIds) {
  console.log(`Discovering projects for ${storeIds.length} stores...`);
  const projectMap = {};
  let offset = 0; const limit = 100;
  while(true) {
    const res = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
    if(!res.data || res.data.length === 0) break;
    
    res.data.forEach(inst => {
      const title = inst.config?.localization?.en_US?.title || "";
      // Regex to find "Store {ID}" projects - Made more flexible to catch "Store 1001", "Store #1001", etc.
      // Removes '$' so trailing text/spaces are ignored
      // Removes '^' so it can find "Store" even if there is a space before it
      const match = title.match(/Store\s*#?\s*(\w+)/i);    
      
      if(match && storeIds.includes(match[1])) {
        console.log(`Found project for store ${match[1]}: ${inst.id}`);
        projectMap[match[1]] = inst.id;
      }
    });
    
    if(res.data.length < limit) break;
    offset += limit;
  }
  console.log(`Total projects found: ${Object.keys(projectMap).length}`);
  return projectMap;
}

// --- ROUTES ---

// 1. VERIFY USERS
app.post("/api/verify-users", async (req, res) => {
  try {
    const { storeIds } = req.body;
    if (!storeIds || !Array.isArray(storeIds)) return res.status(400).json({ error: "Invalid storeIds" });

    // 1. Load the "Phonebook"
    const userMap = await getAllUsersMap();
    
    const foundUsers = [];
    const notFoundIds = [];

    // 2. Instant Lookup
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

// 2. CREATE ADHOC POST & TASKS
// Use upload.single('taskCsv') because the store list is now in req.body
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    let { verifiedUsers, title, department } = req.body;
    
    // Parse the JSON string sent by frontend
    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    // Fallback: If verification wasn't passed, try to resolve raw IDs (Safety net)
    if (!verifiedUsers || verifiedUsers.length === 0) {
       let { storeIds } = req.body;
       if (typeof storeIds === 'string') try { storeIds = JSON.parse(storeIds); } catch(e) {}
       
       if (storeIds && storeIds.length > 0) {
         console.log("Fallback: Resolving raw store IDs...");
         const userMap = await getAllUsersMap();
         verifiedUsers = [];
         for(const id of storeIds) {
           const u = userMap.get(String(id));
           if(u) verifiedUsers.push(u);
         }
       }
    }

    if (!verifiedUsers || verifiedUsers.length === 0) {
      return res.status(400).json({ error: "No verified users provided." });
    }

    // Extract necessary ID lists
    const userIds = verifiedUsers.map(u => u.id); // Internal IDs for Channel Access
    const storeIds = verifiedUsers.map(u => u.csvId); // Store IDs for Task Lists

    console.log(`Processing ${userIds.length} users and ${storeIds.length} store IDs.`);

    // Generate Metadata (Using Hyphens - Safe ID)
    const now = Date.now();
    const metaExternalID = `adhoc-${now}`;

    // A. Create Channel
    console.log("Creating News Channel...");
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { en_US: { title: title }, de_DE: { title: title } }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;

    // [FIX] FORCE UPDATE VISIBILITY
    // Explicitly set the targeting again to ensure it applies.
    console.log(`Applying visibility to ${userIds.length} users...`);
    await sb("PUT", `/installations/${channelId}`, {
      accessorIDs: userIds
    });

    // B. Create Post
    console.log("Creating News Post...");
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: `<p><strong>Category:</strong> ${department}</p><p>Targeted Stores: ${userIds.length}</p>`, 
          teaser: department 
        } 
      }
    });

    // C. Handle Tasks (Using storeIds from input)
    let taskCount = 0;
    if (req.file) {
      console.log("Processing Task CSV...");
      const tasks = parseTaskCSV(req.file.buffer);
      console.log(`Parsed ${tasks.length} tasks.`);
      
      if (tasks.length > 0) {
        // 1. Find matching Store Projects
        const projectMap = await discoverProjectsByStoreIds(storeIds);
        const installationIds = Object.values(projectMap);
        
        console.log(`Found ${installationIds.length} target projects for tasks.`);

        if (installationIds.length === 0) {
            console.warn("WARNING: No matching Store Projects found. Tasks will NOT be created.");
        }
        
        // 2. Chunk requests to create tasks safely
        const chunkedInsts = [];
        for (let i=0; i<installationIds.length; i+=5) chunkedInsts.push(installationIds.slice(i,i+5));

        for (const chunk of chunkedInsts) {
          await Promise.all(chunk.map(async (instId) => {
            try {
              // Create List
              const listRes = await sb("POST", `/tasks/${instId}/lists`, { name: title });
              // Create Tasks
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
            } catch(e) { console.error(`Task error for project ${instId}`, e.message); }
          }));
        }
        taskCount = tasks.length * installationIds.length;
        console.log(`Total tasks created: ${taskCount}`);
      }
    } else {
        console.log("No Task CSV file uploaded.");
    }

    res.json({ success: true, channelId, postId: postRes.id, taskCount });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. GET PAST SUBMISSIONS
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
          item = {
            channelId: inst.id,
            title: title,
            department: "General", 
            userCount: inst.accessorIDs ? inst.accessorIDs.length : 0,
            createdAt: inst.created || new Date().toISOString(),
            status: "Draft"
          };
        }
        // STRATEGY B: Legacy Support
        else if (extID.startsWith('adhoc-v2') || extID.startsWith('adhoc_v2')) {
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

// 4. DELETE
app.delete("/api/delete/:id", async (req, res) => {
  try { await sb("DELETE", `/installations/${req.params.id}`); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

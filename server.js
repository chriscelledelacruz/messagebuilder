const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' })); 

// Multer Setup
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
  throw new Error("API Timeout after retries");
}

// --- LOGIC HELPERS ---

async function getAllUsersMap() {
  const userMap = new Map(); 
  let offset = 0;
  const limit = 100;
  
  // console.log("Fetching full user directory..."); // Commented out to reduce noise
  
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
      const match = title.match(/^Store\s*#?\s*(\w+)$/i);
      
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

// 1. VERIFY USERS
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
    res.status(500).json({ error: err.message });
  }
});

// 2. CREATE ADHOC POST & TASKS
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    // --- DEBUG LOG START ---
    console.log("[CREATE] Raw Body:", req.body);
    // --- DEBUG LOG END ---

    let { verifiedUsers, title, department } = req.body;
    
    // Ensure department has a fallback
    if (!department || department === 'undefined') department = "Uncategorized";

    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

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

    const userIds = verifiedUsers.map(u => u.id);
    const storeIds = verifiedUsers.map(u => u.csvId);

    console.log(`[CREATE] Verified: ${userIds.length} users. Department: ${department}`);

    const now = Date.now();
    const metaExternalID = `adhoc-${now}`;

    // A. Create Channel
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { en_US: { title: title }, de_DE: { title: title } }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;

    // B. Create Post
    // We are baking the metadata into the HTML here
    const contentHTML = `<p><strong>Category:</strong> ${department}</p><p>Targeted Stores: ${userIds.length}</p>`;
    
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: contentHTML, 
          teaser: department 
        } 
      }
    });

    // C. Handle Tasks
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
            } catch(e) {}
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

// 3. GET PAST SUBMISSIONS
app.get("/api/items", async (req, res) => {
  // DISABLE CACHE
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  
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

        if (extID.startsWith('adhoc-') && !extID.includes('|') && !extID.includes('v2')) {
          item = {
            channelId: inst.id,
            title: title,
            department: "General", 
            userCount: 0, 
            createdAt: inst.created || new Date().toISOString(),
            status: "Draft"
          };
        }
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
           // External logic logic...
           // (Kept simple for brevity, assumed legacy)
        }

        if (item) {
          try {
            const posts = await sb("GET", `/channels/${item.channelId}/posts?limit=1`);
            if (posts.data && posts.data.length > 0) {
              const p = posts.data[0];
              let rawContent = p.contents?.en_US?.content || "";
              
              // --- FIX: TEXT-FIRST STRATEGY ---
              const plainText = rawContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              
              // console.log(`[Item ${item.channelId}] Reading Text: "${plainText}"`);

              // 1. Extract Department
              // Look for "Category:" followed by text, until "Targeted" or End of String
              const deptMatch = plainText.match(/Category:\s*(.*?)(?=\s*Targeted Stores:|$)/i);
              if (deptMatch && deptMatch[1]) {
                 item.department = deptMatch[1].trim();
              } else if (p.contents?.en_US?.teaser) {
                 item.department = p.contents.en_US.teaser; 
              }

              // 2. Extract User Count
              const countMatch = plainText.match(/Targeted Stores:\s*(\d+)/i);
              if (countMatch && countMatch[1]) {
                item.userCount = parseInt(countMatch[1], 10);
              }
              
              if (p.published) item.status = "Published";
              else if (p.planned) item.status = "Scheduled";
            }
          } catch(e) { console.error(e); }
          items.push(item);
        }
      }

      if (result.data.length < limit) break;
      offset += limit;
    }

    items.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items });
  } catch (err) {
    console.error("List Error:", err);
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

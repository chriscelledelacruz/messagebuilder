const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// --- FIX 1: DISABLE ETAGS & CACHING ---
app.set('etag', false);
app.disable('view cache');

// Middleware
app.use(express.json({ limit: '50mb' })); 

// Multer Setup
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- API HELPER (UPDATED to support custom headers) ---
async function sb(method, path, body, customHeaders = {}) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const options = {
    method,
    headers: {
      "Authorization": `Basic ${STAFFBASE_TOKEN}`, 
      "Content-Type": "application/json",
      ...customHeaders // Merge in any custom headers
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
  throw new Error("API Timeout after retries");
}

// --- LOGIC HELPERS ---

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- NEW: FETCH OPS GROUP MEMBERS DYNAMICALLY ---
async function getOpsGroupMembers() {
  const OPS_GROUP_ID = "692a1bc3f912873d71f98e39";
  try {
    console.log(`[OPS] Fetching members for group: ${OPS_GROUP_ID}`);
    
    // SCIM Filter: groups eq "ID"
    const filter = encodeURIComponent(`groups eq "${OPS_GROUP_ID}"`);
    
    // Staffbase Search often requires a specific Accept header
    const headers = {
        "Accept": "application/vnd.staffbase.accessors.users-search.v1+json"
    };

    const res = await sb("GET", `/users/search?filter=${filter}`, null, headers);
    
    if (res.data) {
        console.log(`[OPS] Found ${res.data.length} Ops members.`);
        return res.data;
    }
    return [];
  } catch (e) {
    console.warn("[OPS] Failed to fetch Ops members:", e.message);
    return []; // Fail safe: return empty list so the rest of the process continues
  }
}

async function getAllUsersMap() {
  const userMap = new Map(); 
  let offset = 0; const limit = 100;
  
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
    } catch (e) { break; }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. CREATE ADHOC POST & TASKS
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {

    // Debug Incoming Data
    console.log("[CREATE] Payload:", { 
      hasFile: !!req.file, 
      title: req.body.title, 
      dept: req.body.department 
    });

    let { verifiedUsers, title, department } = req.body;

    if (!department || department === 'undefined' || department.trim() === '') {
        department = "Uncategorized";
    }

    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    // Fallback logic
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

    const storeUserIds = verifiedUsers.map(u => u.id);
    const storeIds = verifiedUsers.map(u => u.csvId);

    // --- UPDATE START: DYNAMICALLY FETCH OPS USERS ---
    const opsUsers = await getOpsGroupMembers();
    const opsUserIds = opsUsers.map(u => u.id);
    
    // Combine Store Users + Ops Users (Use Set to prevent duplicates)
    const allAccessorIDs = [...new Set([...storeUserIds, ...opsUserIds])];
    
    console.log(`[CREATE] Visibility: ${storeUserIds.length} Stores + ${opsUserIds.length} Ops Members = ${allAccessorIDs.length} Total`);
    // --- UPDATE END ---

    const now = Date.now();
    const metaExternalID = `adhoc-${now}`;

    // Tasks parsing
    let tasks = [];
    let taskListHTML = "";
    
    if (req.file) {
      tasks = parseTaskCSV(req.file.buffer);
      if (tasks.length > 0) {
        taskListHTML = "<h3>Action Items</h3><ul>";
        tasks.forEach(t => {
          let dateDisplay = "";
          if (t.dueDate) {
             const d = new Date(t.dueDate);
             dateDisplay = ` <span style="color:#666; font-size:0.9em;">(Due: ${d.toLocaleDateString()})</span>`;
          }
          taskListHTML += `<li><strong>${t.title}</strong><br>${t.description || ""}${dateDisplay}</li>`;
        });
        taskListHTML += "</ul>";
      }
    }

    // A. Create Channel
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { en_US: { title: title }, de_DE: { title: title } }
      },
      accessorIDs: allAccessorIDs // Passing valid USER IDs only
    });
    
    const channelId = channelRes.id;

    // B. Create Post
    const contentHTML = `${title}<hr>${taskListHTML}`;
    const contentTeaser = `Category: ${department}; Targeted Stores: ${storeUserIds.length}`
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: contentHTML,
          teaser: contentTeaser,
          kicker: department 
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
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
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
        
       const defaultUserCount = inst.accessorIDs ? inst.accessorIDs.length : 0;
       const dateStr = inst.createdAt || inst.created || new Date().toISOString();
    
        if (extID.startsWith('adhoc')) {
          item = {
            channelId: inst.id,
            title: title,
            department: "Uncategorized", 
            userCount: defaultUserCount,
            createdAt: dateStr,
            status: "Draft"
          };
        }
        else if (title.startsWith('[external]')) {
          const match = title.match(/^\[external\][^:]+:(\d+):([^:]*)::(.*?) - (.+)$/);
          if (match) {
            item = {
              channelId: inst.id,
              title: match[4],
              department: match[3],
              userCount: parseInt(match[1], 10),
              createdAt: dateStr,
              status: "Draft"
            };
          }
        }

        if (item) {
          try {
            const posts = await sb("GET", `/channels/${item.channelId}/posts?limit=1`);
            if (posts.data && posts.data.length > 0) {
              const p = posts.data[0];
              
              const teaserText = p.contents?.en_US?.teaser || "";
              const kickerText = p.contents?.en_US?.kicker || "";
              const rawContent = p.contents?.en_US?.content || "";
              const plainBodyText = cleanText(rawContent);

              let deptMatch = teaserText.match(/(?:Category|Department):\s*([^;]+)/i);
              
              if (deptMatch && deptMatch[1]) {
                  item.department = deptMatch[1].trim(); 
              } 
              else if (kickerText) {
                  item.department = kickerText.trim();
              }
              else {
                  deptMatch = plainBodyText.match(/(?:Category|Department):\s*([^\n\r]*?)(?=\s*(?:Targeted|User Count|$))/i);
                  if (deptMatch && deptMatch[1]) item.department = deptMatch[1].trim();
              }

              let countMatch = teaserText.match(/Targeted Stores:\s*(\d+)/i);
              
              if (countMatch && countMatch[1]) {
                  item.userCount = parseInt(countMatch[1], 10);
              } 
              else {
                  countMatch = plainBodyText.match(/Targeted Stores:\s*(\d+)/i);
                  if (countMatch && countMatch[1]) item.userCount = parseInt(countMatch[1], 10);
              }
              
              if (p.published) item.status = "Published";
              else if (p.planned) item.status = "Scheduled";
            }
          } catch(e) { console.error("Task Error:", e); throw e; }
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

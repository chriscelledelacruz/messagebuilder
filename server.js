const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// --- FIX 1: DISABLE ETAGS & CACHING TO PREVENT 304 ERRORS ---
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

// --- API HELPER ---
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
  throw new Error("API Timeout after retries");
}

// --- LOGIC HELPERS ---

// Helper to clean HTML entities which break Regex
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/&nbsp;/gi, ' ')  // Replace non-breaking space
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, ' ')  // Strip HTML tags
    .replace(/\s+/g, ' ')      // Collapse multiple spaces
    .trim();
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

    // --- FIX 2: Prevent "undefined" Department ---
    if (!department || department === 'undefined' || department.trim() === '') {
        department = "Uncategorized";
    }

    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    // Fallback logic if verifying in frontend failed
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

    console.log(`[CREATE] Final: ${userIds.length} users. Dept: "${department}"`);

    const now = Date.now();
    const metaExternalID = `adhoc-${now}`;

    // --- NEW SECTION START: Parse Tasks Early ---
    let tasks = [];
    let taskListHTML = "";
    
    if (req.file) {
      tasks = parseTaskCSV(req.file.buffer);
      
      if (tasks.length > 0) {
        taskListHTML = "<h3>Action Items</h3><ul>";
        tasks.forEach(t => {
          // Format date if it exists
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
    // --- NEW SECTION END ---

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

    // B. Create Post (Embed Metadata reliably)
    // We add spaces inside the HTML to help the parser later
    const contentHTML = `${taskListHTML}`;    
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: contentHTML, 
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
  // --- FIX 3: AGGRESSIVE CACHE BUSTING ---
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
        
        // Use accessorIDs as a fallback if extraction fails
       const defaultUserCount = inst.accessorIDs ? inst.accessorIDs.length : 0;
    
    // FIX 1: Use 'createdAt' (standard API) and fallback to 'created' just in case
        const dateStr = inst.createdAt || inst.created || new Date().toISOString();
    
// 1. DETERMINE ITEM TYPE & INITIAL METADATA
        
        // SIMPLIFIED: Catch anything starting with "adhoc" (v1, v2, etc.)
        if (extID.startsWith('adhoc')) {
          item = {
            channelId: inst.id,
            title: title,
            department: "Uncategorized", // Default placeholder
            userCount: defaultUserCount,
            createdAt: dateStr,
            status: "Draft"
          };
        }
        else if (title.startsWith('[external]')) {
          // Keep this! It handles your very old migrated data
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
              const rawContent = p.contents?.en_US?.content || "";
              
              // --- FIX 4: CLEAN TEXT EXTRACTION ---
              // Decodes &nbsp; to space, strips tags, trims whitespace
              const plainText = cleanText(rawContent);

              // Logging to help debug if it fails again
              console.log(`[Item ${item.channelId}] Scanned: "${plainText}"`);

              // 1. Extract Department
              // Matches "Category:" followed by text until "Targeted" or End
              // 1. Define your valid departments (The "Source of Truth")
              const validDepartments = ["Merchandising", "Marketing", "Audit", "Operations", "HR", "IT"];
              
              // 2. Try to find the string using a slightly more flexible Regex
              // Matches "Category:" OR "Department:"
              const deptMatch = plainText.match(/(?:Category|Department):\s*([^\n\r]*?)(?=\s*(?:Targeted|User Count|$))/i);
              
              let candidateValue = null;
              
              if (deptMatch && deptMatch[1]) {
                  candidateValue = deptMatch[1].trim();
              } 
              // Only try teaser if we really have to, and honestly, this is risky. 
              // I would recommend REMOVING this teaser fallback unless your teasers are strictly category names.
              else if (p.contents?.en_US?.teaser) {
                  candidateValue = p.contents.en_US.teaser.trim();
              }
              
              // 3. THE VALIDATION STEP (Crucial)
              // We check if the found text (candidateValue) exists in our valid list (case-insensitive)
              if (candidateValue) {
                  // Find the exact spelling from your list (e.g. "hr" -> "HR")
                  const match = validDepartments.find(d => d.toLowerCase() === candidateValue.toLowerCase());
                  
                  if (match) {
                      item.department = match; // Set it to the clean, valid value
                  } else {
                      // We found text, but it wasn't a valid department. 
                      // Reset to empty string so the user sees "Select a Category" instead of "General"
                      item.department = ""; 
                  }
              } else {
                  // Nothing found at all. Reset to empty.
                  item.department = "";
              } 
              
              //const deptMatch = plainText.match(/Category:\s*(.*?)(?=\s*Targeted Stores|Targeted|$)/i);
              //if (deptMatch && deptMatch[1]) {
               //  item.department = deptMatch[1].trim();
              //} else if (p.contents?.en_US?.teaser) {
              //   item.department = p.contents.en_US.teaser; 
              //}

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

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
// 2. CREATE ADHOC POST & TASKS
const cpUpload = upload.fields([{ name: 'taskCsv', maxCount: 1 }, { name: 'profileCsv', maxCount: 1 }]);
app.post("/api/create", cpUpload, async (req, res) => {
  try {
    let { verifiedUsers, title, department } = req.body;

    // --- FIX: Logic cleanup ---
    if (!department || department === 'undefined' || department.trim() === '') {
        department = "Uncategorized";
    }
    if (typeof verifiedUsers === 'string') {
      try { verifiedUsers = JSON.parse(verifiedUsers); } catch(e) {}
    }

    if (!verifiedUsers || verifiedUsers.length === 0) {
      return res.status(400).json({ error: "No verified users provided." });
    }

    const userIds = verifiedUsers.map(u => u.id);
    const storeIds = verifiedUsers.map(u => u.csvId);
    const now = Date.now();
    const metaExternalID = `adhoc-${now}`;

    // 1. DATA PREPARATION: Parse Tasks and Profile Guide
    let taskListHTML = "";
    const taskFile = req.files && req.files['taskCsv'] ? req.files['taskCsv'][0] : null;
    if (taskFile) {
      const tasks = parseTaskCSV(taskFile.buffer);
      if (tasks.length > 0) {
        taskListHTML = "<h3>Action Items</h3><ul>";
        tasks.forEach(t => {
          let dateDisplay = t.dueDate ? ` <span style="color:#666; font-size:0.9em;">(Due: ${new Date(t.dueDate).toLocaleDateString()})</span>` : "";
          taskListHTML += `<li><strong>${t.title}</strong><br>${t.description || ""}${dateDisplay}</li>`;
        });
        taskListHTML += "</ul>";
      }
    }

    let profileMergeHTML = "";
    const profileFile = req.files && req.files['profileCsv'] ? req.files['profileCsv'][0] : null;
    if (profileFile) {
      try {
        const profileText = profileFile.buffer.toString("utf8");
        const rows = profileText.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
        if (rows.length >= 2) { 
          const headers = rows[0].split(/[;,]/); 
          const firstDataRow = rows[1].split(/[;,]/);
          profileMergeHTML = `<h3>Field Merge Guide (First Row)</h3><table border="1" style="border-collapse: collapse; width: 100%; font-size: 0.9em;"><tr style="background: #f4f6f8;"><th style="padding: 8px;">Profile Field (ID)</th><th style="padding: 8px;">Format</th><th style="padding: 8px;">Example</th></tr>`;
          headers.forEach((header, index) => {
            const cleanHeader = header.trim();
            profileMergeHTML += `<tr><td style="padding: 8px;"><code>${cleanHeader}</code></td><td style="padding: 8px;"><code>{{user.profile.${cleanHeader}}}</code></td><td style="padding: 8px; color: #666;">${firstDataRow[index] || ""}</td></tr>`;
          });
          profileMergeHTML += `</table><br>`;
        }
      } catch (err) { console.error("Profile parse error:", err); }
    }

    // 2. STAFFBASE CREATION: Channel & Post
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: { localization: { en_US: { title: title }, de_DE: { title: title } } },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;
    const contentHTML = `${title}<hr>${profileMergeHTML}${taskListHTML}`;
    const contentTeaser = `Category: ${department}; Targeted Stores: ${userIds.length}`;

    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { en_US: { title, content: contentHTML, teaser: contentTeaser, kicker: department } }
    });

    // 3. BACKGROUND TASKS: Staffbase Tasks & Profile Import
    let taskCount = 0;
    if (taskFile) {
      const tasks = parseTaskCSV(taskFile.buffer);
      const projectMap = await discoverProjectsByStoreIds(storeIds);
      const instIds = Object.values(projectMap);
      for (const instId of instIds) {
        try {
          const listRes = await sb("POST", `/tasks/${instId}/lists`, { name: title });
          for (const t of tasks) {
            await sb("POST", `/tasks/${instId}/task`, { taskListId: listRes.id, title: t.title, description: t.description, dueDate: t.dueDate, status: "OPEN" });
          }
        } catch(e) {}
      }
      taskCount = tasks.length * instIds.length;
    }

    let importCount = 0;
    if (profileFile) {
      try {
        const importUrl = `${STAFFBASE_BASE_URL}/users/imports`;
        const importRes = await fetch(importUrl, {
          method: "POST",
          headers: { "Authorization": `Basic ${STAFFBASE_TOKEN}`, "Content-Type": "text/csv; charset=utf-8" },
          body: profileFile.buffer
        });
        if (importRes.ok) importCount = 1;
      } catch (err) { console.error("Profile Import Error:", err); }
    }

    res.json({ success: true, channelId, postId: postRes.id, taskCount, importCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
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
    const contentHTML = `${title}<hr>${profileMergeHTML}${taskListHTML}`;
    const contentTeaser = `Category: ${department}; Targeted Stores: ${userIds.length}`
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

    let importCount = 0;
    if (req.files && req.files['profileCsv']) {
      try {
        console.log("Processing Profile CSV Import...");
        const profileBuffer = req.files['profileCsv'][0].buffer;
        
        // We must send this raw buffer to Staffbase
        // Note: Staffbase import API typically expects the raw CSV content body
        // and Content-Type: text/csv
        
        const importUrl = `${STAFFBASE_BASE_URL}/users/imports`;
        const importRes = await fetch(importUrl, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${STAFFBASE_TOKEN}`,
            "Content-Type": "text/csv; charset=utf-8" // Important for CSV upload
          },
          body: profileBuffer
        });

        if (!importRes.ok) {
          const errText = await importRes.text();
          console.error("Profile Import Failed:", errText);
          // We don't throw here to avoid failing the whole post creation, 
          // but you could add a warning to the response.
        } else {
          const importData = await importRes.json();
          importCount = 1; // Mark as success
          console.log("Profile Import Success:", importData);
        }
      } catch (err) {
        console.error("Profile Import Error:", err);
      }
    }

      res.json({ success: true, channelId, postId: postRes.id, taskCount, importCount });
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
              
              // 1. Get the source text (Prioritize Teaser)
              const teaserText = p.contents?.en_US?.teaser || "";
              const kickerText = p.contents?.en_US?.kicker || "";
              const rawContent = p.contents?.en_US?.content || "";
              const plainBodyText = cleanText(rawContent);

              // 2. EXTRACT DEPARTMENT
              // First try the Teaser
              let deptMatch = teaserText.match(/(?:Category|Department):\s*([^;]+)/i);
              
              if (deptMatch && deptMatch[1]) {
                  item.department = deptMatch[1].trim(); 
              } 
              // Fallback: Check Kicker
              else if (kickerText) {
                  item.department = kickerText.trim();
              }
              // Fallback: Check Body (Legacy support)
              else {
                  deptMatch = plainBodyText.match(/(?:Category|Department):\s*([^\n\r]*?)(?=\s*(?:Targeted|User Count|$))/i);
                  if (deptMatch && deptMatch[1]) item.department = deptMatch[1].trim();
              }

              // 3. EXTRACT USER COUNT
              // First try the Teaser
              let countMatch = teaserText.match(/Targeted Stores:\s*(\d+)/i);
              
              if (countMatch && countMatch[1]) {
                  item.userCount = parseInt(countMatch[1], 10);
              } 
              // Fallback: Check Body (Legacy support)
              else {
                  countMatch = plainBodyText.match(/Targeted Stores:\s*(\d+)/i);
                  if (countMatch && countMatch[1]) item.userCount = parseInt(countMatch[1], 10);
              }
              
              // 4. STATUS
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

const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Multer for Task CSV (storeIds now come as text/JSON in body)
const upload = multer({ storage: multer.memoryStorage() });

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;
// The ID of the Tasks Plugin Installation where Task Lists are defined generally
// If you create lists inside specific Store Projects, this might be dynamic. 
// For this POC, we use a central ID or discover dynamic ones.
const TASKS_PLUGIN_ID = "tasks"; 

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

  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    console.error(`[API Error] ${method} ${path}: ${res.status} - ${txt}`); 
    throw new Error(`API ${res.status}: ${txt}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

// --- LOGIC HELPERS ---

// 1. Find User
async function findUserByHiddenId(csvId) {
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

// 2. Parse Task CSV (Semicolon separated: Title;Desc;Date)
function parseTaskCSV(buffer) {
  try {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const tasks = [];
    
    lines.forEach(line => {
      const [title, desc, date] = line.split(';').map(s => s ? s.trim() : '');
      if (title) {
        // Simple date formatter (assuming input is YYYY-MM-DD or similar)
        let dueDate = null;
        if(date) dueDate = new Date(date).toISOString();
        
        tasks.push({ title, description: desc || "", dueDate });
      }
    });
    return tasks;
  } catch (e) {
    console.error("CSV Parse Error", e);
    return [];
  }
}

// 3. Discover "Store Projects" (Installations named "Store {ID}")
async function discoverProjectsByStoreIds(storeIds) {
  const projectMap = {}; // storeId -> installationId
  let offset = 0; 
  const limit = 100;

  while(true) {
    const res = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
    if(!res.data || res.data.length === 0) break;

    res.data.forEach(inst => {
      const title = inst.config?.localization?.en_US?.title || "";
      // Check if title is like "Store 12345"
      const match = title.match(/^Store\s+(\w+)$/i);
      if(match) {
        const sId = match[1];
        if(storeIds.includes(sId)) {
          projectMap[sId] = inst.id;
        }
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

    const foundUsers = [];
    const notFoundIds = [];

    // Parallel processing for speed in POC (be careful with rate limits in Prod)
    // For safer execution, use a for...of loop
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

// 2. CREATE ADHOC POST (The Main Chain)
app.post("/api/create", upload.single("taskCsv"), async (req, res) => {
  try {
    let { storeIds, title, department } = req.body;
    
    // Parse storeIds if stringified
    if (typeof storeIds === 'string') {
      try { storeIds = JSON.parse(storeIds); } catch(e) {}
    }

    if (!storeIds || storeIds.length === 0) return res.status(400).json({ error: "No stores provided" });

    // A. Resolve Users
    const userIds = [];
    for (const id of storeIds) {
      const user = await findUserByHiddenId(id);
      if (user) userIds.push(user.id);
    }
    if (userIds.length === 0) return res.status(404).json({ error: "No valid users found for these stores." });

    // B. Generate Metadata
    const now = Date.now();
    // Format: adhoc_v2|timestamp|userCount|department
    // We store this in externalID so it's hidden from the UI but searchable by us
    const metaExternalID = `adhoc_v2|${now}|${userIds.length}|${department.replace(/\|/g, '-')}`;

    // C. Create Channel (CLEAN TITLE)
    // We put the "ugly" metadata in externalID, and the clean title in localization
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: metaExternalID, 
      config: {
        localization: { 
          en_US: { title: title }, 
          de_DE: { title: title } 
        }
      },
      accessorIDs: userIds
    });
    
    const channelId = channelRes.id;

    // D. Create Post
    const postRes = await sb("POST", `/channels/${channelId}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: `<p><strong>Department:</strong> ${department}</p><p>Please review the attached tasks.</p>`, 
          teaser: department 
        } 
      }
    });

    // E. Handle Tasks (If CSV present)
    let taskCount = 0;
    if (req.file) {
      const tasks = parseTaskCSV(req.file.buffer);
      if (tasks.length > 0) {
        // 1. Find target projects (Store Installations)
        const projectMap = await discoverProjectsByStoreIds(storeIds);
        const installationIds = Object.values(projectMap);
        
        // 2. Loop through store projects and create list + tasks
        for (const instId of installationIds) {
          try {
            // Create List
            const listRes = await sb("POST", `/tasks/${instId}/lists`, { name: title });
            const listId = listRes.id;
            
            // Create Tasks in List
            for (const t of tasks) {
              await sb("POST", `/tasks/${instId}/task`, {
                taskListId: listId,
                title: t.title,
                description: t.description,
                dueDate: t.dueDate,
                status: "OPEN",
                assigneeIds: [] 
              });
            }
            taskCount += tasks.length;
          } catch (e) {
            console.error(`Failed tasks for inst ${instId}`, e.message);
          }
        }
      }
    }

    res.json({ success: true, channelId, postId: postRes.id, taskCount });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3. GET ITEMS (Past Submissions)
app.get("/api/items", async (req, res) => {
  try {
    const items = [];
    let offset = 0;
    const limit = 100;

    // 1. Fetch all News Installations
    while(true) {
      const result = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
      if (!result.data || result.data.length === 0) break;

      // 2. Filter for our "Adhoc" channels using the externalID prefix
      const adhocChannels = result.data.filter(i => 
        i.pluginID === 'news' && i.externalID && i.externalID.startsWith('adhoc_v2|')
      );

      // 3. Hydrate with Status
      for (const channel of adhocChannels) {
        // Parse metadata: adhoc_v2|timestamp|userCount|department
        const parts = channel.externalID.split('|');
        const timestamp = parseInt(parts[1]);
        const userCount = parts[2];
        const department = parts[3];
        const title = channel.config?.localization?.en_US?.title || "Untitled";

        // Get Posts to determine status
        let status = "Draft";
        let postId = null;
        try {
          const posts = await sb("GET", `/channels/${channel.id}/posts?limit=1`);
          if (posts.data && posts.data.length > 0) {
            const p = posts.data[0];
            postId = p.id;
            if (p.published) status = "Published";
            else if (p.planned) status = "Scheduled";
          }
        } catch(e) {}

        items.push({
          channelId: channel.id,
          title,
          department,
          userCount,
          createdAt: new Date(timestamp).toISOString(),
          status,
          postId
        });
      }

      if (result.data.length < limit) break;
      offset += limit;
    }

    // Sort by date desc
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

const express = require("express");
const multer = require("multer");
const path = require("path");
const FormData = require("form-data"); // NEW DEPENDENCY
require("dotenv").config();

const app = express();

app.set('etag', false);
app.disable('view cache');

app.use(express.json({ limit: '50mb' })); 

// --- FIX: Update Multer to handle named fields ---
const upload = multer({ storage: multer.memoryStorage() });
const cpUpload = upload.fields([{ name: 'taskCsv', maxCount: 1 }, { name: 'profileCsv', maxCount: 1 }]);

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- API HELPER (Generic) ---
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

  // Simple retry logic
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
      throw new Error(`API ${res.status}: ${txt}`);
    }
    if (res.status === 204) return {};
    return res.json();
  }
  throw new Error("API Timeout");
}

// --- NEW: API Helper for File Uploads (Multipart) ---
async function sbUpload(path, buffer, filename) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const form = new FormData();
  form.append('file', buffer, { filename: filename, contentType: 'text/csv' });

  const options = {
    method: 'POST',
    headers: {
      "Authorization": `Basic ${STAFFBASE_TOKEN}`,
      ...form.getHeaders() // Important for boundary
    },
    body: form
  };

  const res = await fetch(url, options);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upload Failed ${res.status}: ${txt}`);
  }
  return res.json(); // Returns { id: "..." }
}

// --- LOGIC HELPERS ---
function cleanText(text) {
  if (!text) return "";
  return text.replace(/<[^>]+>/g, ' ').trim();
}

async function getAllUsersMap() {
  // (Keep your existing getAllUsersMap logic exactly as is)
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
    } catch (e) { break; }
  }
  return userMap;
}

function parseCSV(buffer) {
  try {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return { headers: [], rows: [] };

    // Assume Semicolon or Comma separator based on first line
    const separator = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''));
    
    const rows = lines.slice(1).map(line => {
      // Basic split (Does not handle quoted commas correctly, but sufficient for simple CSVs)
      const values = line.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
      const rowObj = {};
      headers.forEach((h, i) => rowObj[h] = values[i] || "");
      return rowObj;
    });

    return { headers, rows, separator };
  } catch (e) { return { headers: [], rows: [] }; }
}

// --- ROUTE: VERIFY USERS (Keep existing) ---
app.post("/api/verify-users", async (req, res) => {
  // (Keep your existing logic here)
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

// --- ROUTE: CREATE ADHOC POST (Updated) ---
app.post("/api/create", cpUpload, async (req, res) => {
  try {
    let { verifiedUsers, title, department, storeIds: rawStoreIds } = req.body;
    
    // Parse Store IDs if string
    let targetStoreIds = [];
    if (rawStoreIds) {
       try { targetStoreIds = JSON.parse(rawStoreIds); } catch(e) {}
    }

    if (!department || department === 'undefined') department = "Uncategorized";

    // 1. HANDLE PROFILE CSV IMPORT (Option B)
    let fieldMergeTable = "";
    
    if (req.files && req.files['profileCsv']) {
      const file = req.files['profileCsv'][0];
      const parsed = parseCSV(file.buffer);
      
      if (parsed.headers.length > 0) {
        // A. Generate Mapping based on headers
        // We assume one header is "Store ID" (or similar) -> 'externalId'
        // All others -> 'profile-field:{HeaderName}'
        
        const mapping = {};
        let idColumn = parsed.headers.find(h => /store\s*id|external\s*id|id/i.test(h));
        
        if (!idColumn) {
           console.warn("Could not auto-detect ID column in Profile CSV. Defaulting to first column.");
           idColumn = parsed.headers[0];
        }

        mapping["externalId"] = idColumn; // Map ID

        // Map other columns to Custom Profile Fields
        // NOTE: The Header Name MUST match the Staffbase Profile Field ID exactly!
        parsed.headers.forEach(h => {
          if (h !== idColumn) {
            mapping[`profile-field:${h}`] = h;
          }
        });

        console.log("[IMPORT] uploading CSV...", mapping);

        // B. Step 1: Upload File
        const uploadRes = await sbUpload("/users/imports", file.buffer, file.originalname);
        const importId = uploadRes.id;

        // C. Step 2: Configure Import
        await sb("PUT", `/users/imports/${importId}/config`, {
          delta: true, // Only update users in the file
          separator: parsed.separator,
          mapping: mapping
        });

        // D. Step 3: Run Import (Async)
        await sb("PATCH", `/users/imports/${importId}`, { state: "IMPORT_PENDING" });
        console.log(`[IMPORT] Import ${importId} triggered successfully.`);

        // E. Build HTML Table for the Post
        if (parsed.rows.length > 0) {
          const firstRow = parsed.rows[0];
          
          let tableRows = "";
          parsed.headers.forEach(header => {
            if (header !== idColumn) {
              const syntax = `{{user.profile.${header}}}`;
              const value = firstRow[header] || "-";
              tableRows += `
                <tr>
                  <td style="padding:5px; border:1px solid #ccc;">${header}</td>
                  <td style="padding:5px; border:1px solid #ccc;"><code>${syntax}</code></td>
                  <td style="padding:5px; border:1px solid #ccc;">${value}</td>
                </tr>`;
            }
          });

          fieldMergeTable = `
            <h3>Field Merge Reference</h3>
            <table style="width:100%; border-collapse:collapse; margin-top:10px;">
              <tr style="background:#f4f4f4;">
                <th style="text-align:left; padding:5px; border:1px solid #ccc;">Attribute</th>
                <th style="text-align:left; padding:5px; border:1px solid #ccc;">Syntax</th>
                <th style="text-align:left; padding:5px; border:1px solid #ccc;">Sample Value</th>
              </tr>
              ${tableRows}
            </table>
            <hr>
          `;
        }
      }
    }

    // 2. STANDARD POST CREATION (Existing Logic)
    const userMap = await getAllUsersMap();
    const userIds = [];
    
    for (const id of targetStoreIds) {
      const u = userMap.get(String(id));
      if (u) userIds.push(u.id);
    }
    
    // ... (Task parsing logic remains the same, assuming req.files['taskCsv']) ...
    let taskListHTML = "";
    if (req.files && req.files['taskCsv']) {
       const tasks = parseCSV(req.files['taskCsv'][0].buffer).rows; // Use new generic parser
       // ... build task HTML ...
       if (tasks.length > 0) {
         taskListHTML = "<h3>Action Items</h3><ul>";
         tasks.forEach(t => taskListHTML += `<li>${t.Title || t.title}</li>`); // Adjust key based on CSV
         taskListHTML += "</ul>";
       }
    }

    // A. Create Channel
    const now = Date.now();
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: `adhoc-${now}`, 
      config: { localization: { en_US: { title: title }, de_DE: { title: title } } },
      accessorIDs: userIds
    });
    
    // B. Create Post (Include Field Merge Table)
    const contentHTML = `${fieldMergeTable} ${title}<hr>${taskListHTML}`;
    
    const postRes = await sb("POST", `/channels/${channelRes.id}/posts`, {
      contents: { 
        en_US: { 
          title: title, 
          content: contentHTML,
          teaser: `Category: ${department}; Targeted Stores: ${userIds.length}`,
          kicker: department 
        } 
      }
    });

    res.json({ success: true, channelId: channelRes.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ... (Rest of routes: GET /api/items, DELETE, app.listen) ...
// (Copy them from your previous file, they don't need changes)

// Just for completeness of the snippet:
app.get("/api/items", async (req, res) => { /* ... existing code ... */ res.json({items:[]}); });
app.delete("/api/delete/:id", async (req, res) => { /* ... existing code ... */ res.json({success:true}); });
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running`));

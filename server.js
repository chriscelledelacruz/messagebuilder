const express = require("express");
const multer = require("multer");
const path = require("path");
const FormData = require("form-data"); 
const { Blob } = require("buffer"); // Required for Native FormData compatibility
require("dotenv").config();

const app = express();

app.set('etag', false);
app.disable('view cache');

app.use(express.json({ limit: '50mb' })); 

const upload = multer({ storage: multer.memoryStorage() });
const cpUpload = upload.fields([{ name: 'taskCsv', maxCount: 1 }, { name: 'profileCsv', maxCount: 1 }]);

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
      await delay(2000);
      retries--;
      continue;
    }
    
    if (res.status === 204) return {}; 

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API ${res.status}: ${txt}`);
    }
    
    return res.json();
  }
  throw new Error("API Timeout");
}

// --- SAFE UPLOAD HELPER ---
async function sbUpload(path, buffer, filename) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const form = new FormData();
  
  // Wrap buffer in a Blob for native Node.js fetch compatibility
  const blob = new Blob([buffer], { type: 'text/csv' });
  form.append('file', blob, filename);

  const options = {
    method: 'POST',
    headers: {
      "Authorization": `Basic ${STAFFBASE_TOKEN}`,
      // Do NOT set Content-Type manually; fetch handles boundary
    },
    body: form,
    duplex: 'half' // Required for Node.js 18+
  };

  const res = await fetch(url, options);

  if (res.status === 204) return { id: null };

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Upload Failed ${res.status}: ${txt}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {}; 
}

// --- CSV PARSER ---
function parseCSV(buffer) {
  try {
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return { headers: [], rows: [] };

    const separator = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''));
    
    const rows = lines.slice(1).map(line => {
      const values = line.split(separator).map(v => v.trim().replace(/^"|"$/g, ''));
      const rowObj = {};
      headers.forEach((h, i) => rowObj[h] = values[i] || "");
      return rowObj;
    });

    return { headers, rows, separator };
  } catch (e) { return { headers: [], rows: [] }; }
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/<[^>]+>/g, ' ').trim();
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
    } catch (e) { break; }
  }
  return userMap;
}

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

// 2. CREATE POST
app.post("/api/create", cpUpload, async (req, res) => {
  try {
    let { verifiedUsers, title, department, storeIds: rawStoreIds } = req.body;
    if (!department || department === 'undefined') department = "Uncategorized";

    // --- HANDLE PROFILE CSV IMPORT ---
    let fieldMergeTable = "";
    
    if (req.files && req.files['profileCsv']) {
      const file = req.files['profileCsv'][0];
      const parsed = parseCSV(file.buffer);
      
      if (parsed.headers.length > 0) {
        let idColumn = parsed.headers.find(h => /store\s*id|external\s*id|id/i.test(h)) || parsed.headers[0];
        const mapping = {};
        mapping["externalId"] = idColumn;

        parsed.headers.forEach(h => {
          if (h !== idColumn) {
            mapping[`profile-field:${h}`] = h;
          }
        });

        console.log("[IMPORT] Triggering CSV Import...", mapping);

        const uploadRes = await sbUpload("/users/imports", file.buffer, file.originalname);
        const importId = uploadRes.id;

        // --- FIX: USE PATCH INSTEAD OF PUT ---
        await sb("PATCH", `/users/imports/${importId}/config`, {
          delta: true,
          separator: parsed.separator,
          mapping: mapping
        });

        await sb("PATCH", `/users/imports/${importId}`, { state: "IMPORT_PENDING" });
        console.log(`[IMPORT] Started import ${importId}`);

        if (parsed.rows.length > 0) {
          const firstRow = parsed.rows[0];
          let tableRows = "";
          parsed.headers.forEach((header, index) => {
            if (header !== idColumn) {
              const syntax = `{{user.profile.${header}}}`;
              const value = firstRow[header] || "-";
              const bg = index % 2 === 0 ? "#ffffff" : "#f9f9f9";
              tableRows += `
                <tr style="background-color:${bg};">
                  <td style="padding:10px; border-bottom:1px solid #eee; color:#333;"><strong>${header}</strong></td>
                  <td style="padding:10px; border-bottom:1px solid #eee; font-family:monospace; color:#0056b3;">${syntax}</td>
                  <td style="padding:10px; border-bottom:1px solid #eee; color:#666;">${value}</td>
                </tr>`;
            }
          });
          fieldMergeTable = `
            <div style="margin-top:20px; font-family: sans-serif;">
              <h3 style="margin-bottom:10px; color:#333;">Field Merge Reference</h3>
              <div style="overflow-x:auto; border:1px solid #eee; border-radius:6px;">
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                  <thead>
                    <tr style="background-color:#f4f6f8; text-align:left;">
                      <th style="padding:10px; border-bottom:2px solid #ddd; width:30%;">Attribute</th>
                      <th style="padding:10px; border-bottom:2px solid #ddd; width:40%;">Syntax</th>
                      <th style="padding:10px; border-bottom:2px solid #ddd; width:30%;">Sample Value</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows}</tbody>
                </table>
              </div>
            </div>`;
        }
      }
    }

    // --- STANDARD POST CREATION ---
    const userIds = [];
    if (!verifiedUsers) {
       let targetStoreIds = [];
       if (rawStoreIds) try { targetStoreIds = JSON.parse(rawStoreIds); } catch(e) {}
       const userMap = await getAllUsersMap();
       targetStoreIds.forEach(id => { const u = userMap.get(String(id)); if(u) userIds.push(u.id); });
    } else {
       // logic for pre-verified object if needed
    }
    
    let taskListHTML = "";
    if (req.files && req.files['taskCsv']) {
       const taskRows = parseCSV(req.files['taskCsv'][0].buffer).rows;
       if (taskRows.length > 0) {
         taskListHTML = "<h3>Action Items</h3><ul>";
         taskRows.forEach(t => taskListHTML += `<li><strong>${t.Title || t.title}</strong>: ${t.Description || t.description || ''}</li>`);
         taskListHTML += "</ul>";
       }
    }

    const now = Date.now();
    const channelRes = await sb("POST", `/spaces/${STAFFBASE_SPACE_ID}/installations`, {
      pluginID: "news",
      externalID: `adhoc-${now}`, 
      config: { localization: { en_US: { title: title }, de_DE: { title: title } } },
      accessorIDs: userIds
    });

    let contentHTML = "";
    if (taskListHTML) contentHTML += taskListHTML;
    else contentHTML += `<p>Please review the details below.</p>`; 

    if (fieldMergeTable) contentHTML += `<br><hr style="border:0; border-top:1px solid #eee; margin: 20px 0;">${fieldMergeTable}`;

    await sb("POST", `/channels/${channelRes.id}/posts`, {
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

// 3. GET ITEMS
app.get("/api/items", async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  try {
    const items = [];
    let offset = 0; const limit = 100;
    while(true) {
      const result = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
      if (!result.data || result.data.length === 0) break;

      for (const inst of result.data) {
        if (inst.pluginID !== 'news') continue;
        const extID = inst.externalID || "";
        const title = inst.config?.localization?.en_US?.title || "Untitled";
        const dateStr = inst.createdAt || inst.created || new Date().toISOString();

        if (extID.startsWith('adhoc') || title.startsWith('[external]')) {
           const item = { 
             channelId: inst.id, 
             title, 
             status: "Draft", 
             department: "Uncategorized", 
             createdAt: dateStr,
             userCount: inst.accessorIDs ? inst.accessorIDs.length : 0
           };
           
           try {
             const posts = await sb("GET", `/channels/${inst.id}/posts?limit=1`);
             if (posts.data && posts.data.length > 0) {
               const p = posts.data[0];
               if (p.published) item.status = "Published";
               else if (p.planned) item.status = "Scheduled";
               item.department = p.contents?.en_US?.kicker || item.department;
               
               const teaser = p.contents?.en_US?.teaser || "";
               const countMatch = teaser.match(/Targeted Stores:\s*(\d+)/);
               if(countMatch) item.userCount = countMatch[1];
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
    console.error("List Error:", err);
    res.json({ items: [] });
  }
});

// 4. DELETE
app.delete("/api/delete/:id", async (req, res) => {
  try { await sb("DELETE", `/installations/${req.params.id}`); res.json({ success: true }); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Needed for Vercel
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 Server running`));
}

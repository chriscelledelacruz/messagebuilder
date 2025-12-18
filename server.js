const express = require("express");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const uploadMulti = multer({ storage: multer.memoryStorage() }).fields([
  { name: "csv", maxCount: 1 },
  { name: "taskCsv", maxCount: 1 }
]);

const STAFFBASE_BASE_URL = process.env.STAFFBASE_BASE_URL;
const STAFFBASE_TOKEN = process.env.STAFFBASE_TOKEN;
const STAFFBASE_SPACE_ID = process.env.STAFFBASE_SPACE_ID;
const HIDDEN_ATTRIBUTE_KEY = process.env.HIDDEN_ATTRIBUTE_KEY;

// Validate required environment variables
const requiredEnvVars = [
  "STAFFBASE_BASE_URL",
  "STAFFBASE_TOKEN",
  "STAFFBASE_SPACE_ID",
  "HIDDEN_ATTRIBUTE_KEY"
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// Discover created channels by querying API and filtering for [external] prefix
async function discoverCreatedChannels() {
  try {
    const channels = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      // Query installations in the space (where news channels are created)
      const result = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
      
      if (!result.data || result.data.length === 0) {
        break;
      }

      // Filter for news plugin installations with [external] prefix in title
      const createdChannels = result.data.filter(installation => {
        if (installation.pluginID !== "news") return false;
        const title = installation.config?.localization?.en_US?.title || "";
        return title.startsWith("[external]");
      });

      // Convert installations to channel-like objects with the info we need
      for (const installation of createdChannels) {
        const accessorCount = installation.accessorIDs?.length || 0;
        
        // The channel ID might be stored in pluginInstance or channelId field
        let channelId = installation.id;
        if (installation.pluginInstance?.id) {
          channelId = installation.pluginInstance.id;
        } else if (installation.channelId) {
          channelId = installation.channelId;
        }
        
        channels.push({
          id: channelId,
          installationId: installation.id,
          label: installation.config?.localization?.en_US?.title || "",
          memberCount: accessorCount,
          accessorIDs: installation.accessorIDs || [],
          created: installation.created || new Date().toISOString(),
          pluginID: installation.pluginID
        });
        console.log(`Found installation ${installation.id}, channel: ${channelId}, users: ${accessorCount}`);
      }

      if (result.data.length < limit) {
        break;
      }

      offset += limit;
    }

    console.log(`Discovered ${channels.length} created channels`);
    return channels;
  } catch (err) {
    console.error("Failed to discover created channels:", err.message);
    return [];
  }
}

// Get posts for a channel (news installation)
async function getChannelPosts(channelId) {
  try {
    // Try to fetch posts using the channel ID
    let result = await sb("GET", `/channels/${channelId}/posts`);
    if (result.data && result.data.length > 0) {
      console.log(`✓ getChannelPosts(${channelId}): Got ${result.data.length} posts from /channels endpoint`);
      return result.data;
    }
    
    // If that didn't work, try querying all posts and filter
    console.log(`⚠ No posts from /channels/${channelId}/posts, trying alternative...`);
    result = await sb("GET", `/posts?limit=100`);
    if (result.data && result.data.length > 0) {
      const filtered = result.data.filter(p => p.channelId === channelId);
      console.log(`✓ Found ${filtered.length} posts for channel ${channelId} from /posts endpoint`);
      return filtered;
    }
    
    console.log(`✓ No posts found for channel ${channelId}`);
    return [];
  } catch (err) {
    console.warn(`⚠ getChannelPosts(${channelId}): ${err.message}`);
    return [];
  }
}

// Staffbase API helper
async function sb(method, path, body) {
  const url = `${STAFFBASE_BASE_URL}${path}`;
  const jsonBody = body ? JSON.stringify(body) : undefined;

  console.log(`[API] ${method} ${url}`);
  if (body) {
    console.log(`[API] Body: ${JSON.stringify(body)}`);
  }

  // Store this request for debugging
  lastApiRequest = {
    method,
    url,
    headers: {
      "Authorization": STAFFBASE_TOKEN,
      "Content-Type": "application/json"
    },
    body: body || null,
    timestamp: new Date().toISOString()
  };

  // Also track task-specific requests
  if (path.includes("/tasks/") && path.includes("/lists")) {
    lastTaskListRequest = lastApiRequest;
    console.log(`[TASK LIST] Recording task list request`);
  }
  if (path.includes("/tasks/") && path.includes("/task") && !path.includes("/lists")) {
    lastTaskRequest = lastApiRequest;
    console.log(`[TASK] Recording task creation request`);
  }

  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": STAFFBASE_TOKEN,
      "Content-Type": "application/json"
    },
    body: jsonBody
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(`[API] Error ${res.status}: ${text}`);
    throw new Error(`Staffbase API ${res.status}: ${text}`);
  }

  // Handle 204 No Content and other empty responses
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return {};
  }

  return res.json();
}

// Lookup user by hidden attribute value (custom profile field)
// Fetches all users and filters client-side since API search is unreliable
async function findUserByHiddenId(csvId) {
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const result = await sb("GET", `/users?limit=${limit}&offset=${offset}`);
    
    if (!result.data || result.data.length === 0) {
      break;
    }
    
    // Find user with matching custom profile attribute
    const found = result.data.find(user => user.profile?.[HIDDEN_ATTRIBUTE_KEY] === csvId);
    if (found) {
      return found;
    }
    
    // Stop if we got fewer results than limit
    if (result.data.length < limit) {
      break;
    }
    
    offset += limit;
  }
  
  return null;
}



// Create News channel via space installation with [external] prefix
async function createNewsChannel({ spaceId, title, userIds, externalId }) {
  // Channel name with [external] prefix and encoded user count
  const userCount = userIds.length;
  const channelName = `[external]${externalId}:${userCount} - ${title}`;
  
  const payload = {
    pluginID: "news",
    config: {
      body: {
        "Transform_Input_into_JSON": {
          "0": channelName
        }
      },
      localization: {
        de_DE: { title: channelName },
        en_US: { title: channelName }
      }
    },
    accessorIDs: userIds,
    contributorIDs: [],
    contentType: "article",
    published: "now",
    notificationChannelsAllowed: [],
    notificationChannelsDefault: []
  };
  
  const response = await sb("POST", `/spaces/${spaceId}/installations`, payload);
  
  // Extract channel ID from response (can be id or pluginInstance.id)
  const channelId = response.id || response.pluginInstance?.id;
  if (!channelId) {
    throw new Error("Channel creation succeeded but no ID in response");
  }
  
  return { ...response, channelId };
}



// Rename channel to include post ID and department (using POST to /installations endpoint)
async function renameChannelWithPostInfo(spaceId, channelId, externalId, userCount, postId, taskListId, department, title) {
  const newLabel = `[external]${externalId}:${userCount}:${postId}:${taskListId}:${department} - ${title}`;
  console.log(`Renaming channel ${channelId} to: ${newLabel}`);
  
  try {
    // Try to update the installation config via POST
    const result = await sb("POST", `/installations/${channelId}`, {
      config: {
        localization: {
          de_DE: { title: newLabel },
          en_US: { title: newLabel }
        }
      }
    });
    console.log(`✓ Successfully renamed channel`);
    return result;
  } catch (err) {
    console.warn(`⚠ Failed to rename channel: ${err.message}`);
    return null;
  }
}

// Create news post in channel
async function createNewsPost(channelId, title, department) {
  const postPayload = {
    externalID: `post-${Date.now()}`,
    contents: {
      en_US: {
        title,
        content: `<p>${title}</p>`,
        teaser: department
      }
    }
  };
  
  // Try different endpoint patterns for news installations
  try {
    // First try with the installation ID directly (our current approach)
    return await sb("POST", `/channels/${channelId}/posts`, postPayload);
  } catch (err) {
    console.log(`First attempt failed for ${channelId}, trying alternative...`);
    // If that fails, try via installations endpoint
    try {
      return await sb("POST", `/installations/${channelId}/posts`, postPayload);
    } catch (err2) {
      console.error("Both post endpoints failed:", err.message, err2.message);
      throw err;
    }
  }
}

// Create task list for the post
async function createTaskList(installationId, title) {
  const TASKS_INSTALLATION_ID = "6928e52b8ab88d050a766901";
  
  const taskListPayload = {
    name: title,
    color: "#007bff"  // Blue color
  };
  
  try {
    const result = await sb("POST", `/tasks/${TASKS_INSTALLATION_ID}/lists`, taskListPayload);
    console.log(`✓ Created task list for post: ${title}, ID: ${result.id}`);
    return result;
  } catch (err) {
    console.warn(`⚠ Failed to create task list: ${err.message}`);
    // Don't throw - task list creation is optional and shouldn't block post creation
    return null;
  }
}

// Delete task list(s)
async function deleteTaskList(taskListId, installationId) {
  try {
    await sb("DELETE", `/tasks/${installationId}/lists/${taskListId}`);
    console.log(`✓ Deleted task list: ${taskListId}`);
    return true;
  } catch (err) {
    console.warn(`⚠ Failed to delete task list ${taskListId}: ${err.message}`);
    // Don't throw - task list deletion is optional and shouldn't block post deletion
    return false;
  }
}

// Discover projects (installations) matching store IDs from the store CSV
async function discoverProjectsByStoreIds(storeIds) {
  try {
    const projectMap = {}; // Map of storeId -> installationId
    let offset = 0;
    const limit = 100;

    while (true) {
      // Query installations in the space
      const result = await sb("GET", `/spaces/${STAFFBASE_SPACE_ID}/installations?limit=${limit}&offset=${offset}`);
      
      if (!result.data || result.data.length === 0) {
        break;
      }

      // Find installations matching "Store {storeId}" pattern
      for (const installation of result.data) {
        const title = installation.config?.localization?.en_US?.title || "";
        
        // Check if title matches "Store {storeId}" pattern
        for (const storeId of storeIds) {
          if (title === `Store ${storeId}`) {
            projectMap[storeId] = installation.id;
            console.log(`✓ Found project for store ${storeId}: ${installation.id}`);
          }
        }
      }

      if (result.data.length < limit) {
        break;
      }

      offset += limit;
    }

    console.log(`Discovered projects for ${Object.keys(projectMap).length}/${storeIds.length} stores`);
    return projectMap;
  } catch (err) {
    console.error("Failed to discover projects by store IDs:", err.message);
    throw err;
  }
}

// Parse task CSV - semicolon-delimited format: title;description;date
function parseTaskCSV(csvBuffer) {
  try {
    const csv = csvBuffer.toString("utf8");
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    
    const tasks = [];
    for (const line of lines) {
      const parts = line.split(';').map(p => p.trim());
      if (parts.length >= 3) {
        const title = parts[0];
        const description = parts[1];
        let dueDate = null;
        const dateStr = parts[2];
        
        // Convert date to ISO 8601 format if provided
        if (dateStr && dateStr.trim()) {
          try {
            // Check if format is DD.MM.YYYY
            if (dateStr.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
              const [day, month, year] = dateStr.split('.');
              // Format as ISO 8601 with Z timezone: YYYY-MM-DDTHH:MM:SSZ
              dueDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T23:59:59Z`;
            } else if (dateStr.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
              // Handle MM/DD/YYYY format (North America)
              const [month, day, year] = dateStr.split('/');
              dueDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T23:59:59Z`;
            } else {
              // Try to parse as standard date format
              const parsed = new Date(dateStr);
              if (!isNaN(parsed.getTime())) {
                // Format as ISO 8601 with Z timezone
                const year = parsed.getFullYear();
                const month = String(parsed.getMonth() + 1).padStart(2, '0');
                const day = String(parsed.getDate()).padStart(2, '0');
                dueDate = `${year}-${month}-${day}T23:59:59Z`;
              }
            }
          } catch (e) {
            console.warn(`Could not parse date "${dateStr}" for task "${title}"`);
          }
        }
        
        tasks.push({
          title,
          description,
          dueDate
        });
      }
    }
    
    console.log(`✓ Parsed ${tasks.length} tasks from task CSV`);
    return tasks;
  } catch (err) {
    console.error("Failed to parse task CSV:", err.message);
    throw err;
  }
}

// Create a task list in a given installation and populate with tasks
async function createTaskListWithTasks(installationId, listName, tasks) {
  try {
    // Create the task list
    const taskListPayload = {
      name: listName,
      color: "#007bff"  // Blue color
    };
    
    const listResult = await sb("POST", `/tasks/${installationId}/lists`, taskListPayload);
    const listId = listResult.id;
    console.log(`✓ Created task list in project ${installationId}: ${listName} (ID: ${listId})`);
    
    // First, try to get installation groups to verify permissions
    try {
      const groups = await sb("GET", `/tasks/${installationId}/groups`);
      console.log(`✓ Installation has ${groups.length} groups, can access task APIs`);
    } catch (err) {
      console.warn(`⚠ Could not retrieve groups: ${err.message}`);
    }
    
    // Create each task in the list
    let createdCount = 0;
    for (const task of tasks) {
      // Skip tasks with no title
      if (!task.title || !task.title.trim()) {
        console.warn(`  ⚠ Skipping task with empty title`);
        continue;
      }
      
      const taskPayload = {
        title: task.title.trim(),
        taskListId: listId
      };
      
      // Add optional fields only if they have values
      if (task.description && task.description.trim()) {
        taskPayload.description = task.description.trim();
      }
      
      if (task.dueDate && typeof task.dueDate === 'string' && task.dueDate.trim()) {
        taskPayload.dueDate = task.dueDate;
        // Also set startDate to the same date at 9 AM (as shown in API docs)
        taskPayload.startDate = task.dueDate.replace('23:59:59', '09:00:00');
      }
      
      // Add required fields per API spec
      taskPayload.status = "OPEN";  // Required: task status
      taskPayload.assigneeIds = [];  // Required: empty array for unassigned
      taskPayload.groupIds = [];     // Required: empty array
      
      try {
        const result = await sb("POST", `/tasks/${installationId}/task`, taskPayload);
        console.log(`  ✓ Created task: ${task.title} (ID: ${result.id})`);
        createdCount++;
      } catch (err) {
        // Check if it's a 403 permission error
        if (err.message.includes('403')) {
          console.warn(`  ⚠ Task creation requires additional permissions (403 Access denied)`);
          console.warn(`     Task: "${task.title}" - cannot create due to insufficient permissions`);
        } else {
          console.warn(`  ⚠ Failed to create task ${task.title}: ${err.message}`);
        }
      }
    }
    
    if (createdCount < tasks.length && createdCount === 0) {
      console.warn(`⚠ WARNING: No tasks could be created. The API token may lack 'create_task' permission.`);
      console.warn(`   Task lists were created successfully, but they are empty.`);
      console.warn(`   Please verify your Staffbase API token has permission to create tasks.`);
    }
    
    console.log(`✓ Created ${createdCount} tasks out of ${tasks.length}`);
    return { listId, taskCount: createdCount };
  } catch (err) {
    console.error(`Failed to create task list with tasks in ${installationId}:`, err.message);
    throw err;
  }
}

// Create task lists in multiple stores from a store CSV
async function createMultiStoreTaskLists(storeIds, postTitle, tasks) {
  try {
    // Discover projects for the stores
    const projectMap = await discoverProjectsByStoreIds(storeIds);
    
    const results = {};
    const allTaskLists = []; // Store all task list IDs for later deletion
    
    // For each store that has a project, create a task list
    for (const storeId of storeIds) {
      const installationId = projectMap[storeId];
      
      if (!installationId) {
        console.warn(`⚠ No project found for store ${storeId}, skipping task list creation`);
        results[storeId] = { error: "Project not found" };
        continue;
      }
      
      try {
        const result = await createTaskListWithTasks(installationId, postTitle, tasks);
        results[storeId] = { success: true, installationId, ...result };
        if (result.listId) {
          allTaskLists.push({ storeId, installationId, listId: result.listId });
        }
      } catch (err) {
        console.error(`Failed to create task list for store ${storeId}:`, err.message);
        results[storeId] = { error: err.message };
      }
    }
    
    results._allTaskLists = allTaskLists; // Store list of all task lists for deletion
    return results;
  } catch (err) {
    console.error("Failed to create multi-store task lists:", err.message);
    throw err;
  }
}

// SERVE FRONTEND
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// Store last API request for debugging
let lastApiRequest = null;
let lastTaskListRequest = null;
let lastTaskRequest = null;

// DEBUG: Show exact last API call
app.get("/api/debug-last-request", (req, res) => {
  if (!lastApiRequest) {
    return res.json({ message: "No API requests recorded yet. Create a test post to capture a request." });
  }
  
  res.json({
    ...lastApiRequest,
    notes: "Copy this entire request details into Postman to test"
  });
});

// DEBUG: Show exact last task list creation request
app.get("/api/debug-task-list-request", (req, res) => {
  if (!lastTaskListRequest) {
    return res.json({ message: "No task list requests recorded yet. Create a test post to capture a request." });
  }
  
  res.json({
    ...lastTaskListRequest,
    notes: "This is the TASK LIST creation request. Copy into Postman to test."
  });
});

// DEBUG: Show exact last task creation request
app.get("/api/debug-task-request", (req, res) => {
  if (!lastTaskRequest) {
    return res.json({ message: "No task creation requests recorded yet." });
  }
  
  res.json({
    ...lastTaskRequest,
    notes: "This is the TASK creation request (inside a task list). Copy into Postman to test."
  });
});

// API: Get created channels by discovering them from API
app.get("/api/items", async (req, res) => {
  try {
    const channels = await discoverCreatedChannels();
    
    const items = [];
    for (const channel of channels) {
      const label = channel.label || "";
      
      // Extract metadata from label
      // Format: [external]{externalId}:userCount:postId:taskListsMetadata:department - title
      // The taskListsMetadata is a JSON string, so we need to find it carefully
      const externalMatch = label.match(/^(\[external\][^:]+:\d+:[^\s:]+:)(.+?):([^\s:]+)\s*-\s*(.+)$/);
      
      let externalId = "unknown";
      let userCount = 0;
      let postId = null;
      let taskListId = null;
      let taskLists = [];
      let department = "Unknown";
      let plainTitle = "";
      
      if (externalMatch) {
        // Parse the first part: [external]externalId:userCount:postId
        const firstPart = externalMatch[1];
        const firstMatch = firstPart.match(/\[external\]([^:]+):(\d+):([^\s:]+):/);
        if (firstMatch) {
          externalId = firstMatch[1];
          userCount = parseInt(firstMatch[2]);
          postId = firstMatch[3];
        }
        
        const taskListsStr = externalMatch[2];
        department = externalMatch[3];
        plainTitle = externalMatch[4];
        
        // Try to parse task lists metadata
        try {
          taskLists = JSON.parse(taskListsStr);
          if (Array.isArray(taskLists) && taskLists.length > 0) {
            taskListId = taskLists[0].listId; // Keep first for backward compat
          }
        } catch (e) {
          // Fallback to treating as single ID (old format)
          taskListId = taskListsStr;
        }
      } else {
        // Fallback to old parsing logic for compatibility
        const legacyMatch = label.match(/\[external\]([^:]+):(\d+)(?::([^\s:]+))?(?::([^\s:]+))?(?::([^\s-]+))?\s*-\s*/);
        if (legacyMatch) {
          externalId = legacyMatch[1];
          userCount = parseInt(legacyMatch[2]);
          postId = legacyMatch[3];
          taskListId = legacyMatch[4];
          department = legacyMatch[5] || "Unknown";
        }
        plainTitle = label.replace(/^\[external\][^:]+:\d+(?::[^\s:]+)?(?::[^\s:]+)?(?::[^\s-]+)?\s*-\s*/, "").trim();
      }
      
      // Build posts array from encoded data
      let posts = [];
      if (postId) {
        posts.push({
          postId: postId,
          title: plainTitle,
          createdAt: channel.created || new Date().toISOString()
        });
        const taskListInfo = taskLists.length > 0 ? `${taskLists.length} lists` : (taskListId ? "1 list" : "no lists");
        console.log(`✓ Channel ${channel.id}: postId=${postId}, ${taskListInfo}, dept=${department}`);
      } else {
        console.log(`⚠ Channel ${channel.id}: No postId in label`);
      }
      
      items.push({
        channelId: channel.id,
        installationId: channel.installationId,
        title: plainTitle,
        externalId,
        userCount,
        department,
        taskListId,
        taskLists,
        createdAt: channel.created || new Date().toISOString(),
        posts: posts
      });
    }
    
    // Sort items by creation date descending (newest first)
    items.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA;  // Descending order (newest first)
    });
    
    console.log(`Returning ${items.length} items to frontend (sorted newest first)`);
    res.json({ items });
  } catch (err) {
    console.error("API Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE API ROUTE - Delete a channel installation and all associated task lists
app.delete("/api/delete/:channelId", async (req, res) => {
  try {
    const { channelId } = req.params;

    if (!channelId) {
      return res.status(400).json({ error: "Channel ID is required." });
    }

    // First, fetch the channel/installation to get its metadata from the label
    try {
      const installation = await sb("GET", `/installations/${channelId}`);
      const label = installation.config?.localization?.en_US?.title || "";
      
      console.log(`Channel label: ${label}`);
      
      // Extract task lists metadata from label
      // Format: [external]{externalId}:userCount:postId:taskListsMetadata:department - title
      // The taskListsMetadata is a JSON string, followed by a colon, then department, then " - ", then title
      
      // First, find where the [external] prefix ends and where the title starts (after " - ")
      const externalMatch = label.match(/^(\[external\][^:]+:\d+:[^\s:]+:)(.+?):([^\s:]+)\s*-\s*(.+)$/);
      
      if (externalMatch) {
        const taskListsStr = externalMatch[2]; // The metadata part
        const department = externalMatch[3];
        const title = externalMatch[4];
        
        console.log(`Extracted metadata: ${taskListsStr}, department: ${department}, title: ${title}`);
        
        try {
          // Try to parse as JSON (new format with multiple task lists)
          const taskLists = JSON.parse(taskListsStr);
          if (Array.isArray(taskLists)) {
            console.log(`Found ${taskLists.length} task lists to delete`);
            for (const taskListInfo of taskLists) {
              console.log(`Deleting task list ${taskListInfo.listId} from installation ${taskListInfo.installationId}`);
              await deleteTaskList(taskListInfo.listId, taskListInfo.installationId);
            }
          }
        } catch (parseErr) {
          // Fallback to old format (single task list ID)
          const taskListId = taskListsStr;
          if (taskListId && taskListId !== "unknown" && taskListId !== "null") {
            console.log(`Deleting task list (legacy format): ${taskListId}`);
            await deleteTaskList(taskListId);
          }
        }
      }
    } catch (err) {
      console.warn(`⚠ Could not fetch channel metadata: ${err.message}`);
      // Continue with channel deletion even if metadata fetch fails
    }

    // Delete the installation via the Staffbase API
    await sb("DELETE", `/installations/${channelId}`);

    res.json({
      success: true,
      message: `Channel ${channelId} and all associated task lists deleted successfully`
    });

  } catch (err) {
    console.error("API Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// VERIFY USERS ENDPOINT
app.post("/api/verify-users", upload.single("csv"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required." });
    }

    // Parse CSV - one user ID per line
    const csv = req.file.buffer.toString("utf8");
    const csvIds = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (csvIds.length === 0) {
      return res.status(400).json({ error: "CSV file is empty." });
    }

    // Look up users by their hidden profile attribute
    const foundUsers = [];
    const notFoundIds = [];

    for (const csvId of csvIds) {
      const user = await findUserByHiddenId(csvId);
      if (user) {
        foundUsers.push({
          id: user.id,
          csvId: csvId,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown'
        });
      } else {
        notFoundIds.push(csvId);
      }
    }

    res.json({
      foundUsers,
      notFoundIds,
      totalRequested: csvIds.length,
      totalFound: foundUsers.length,
      totalNotFound: notFoundIds.length
    });

  } catch (err) {
    console.error("API Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// MAIN API ROUTE
app.post("/api/create", uploadMulti, async (req, res) => {
  try {
    const { department, title, notify } = req.body;

    // Validate required fields
    if (!req.files || !req.files.csv || !req.files.csv[0]) {
      return res.status(400).json({ error: "Store CSV file is required." });
    }

    if (!title || title.trim() === "") {
      return res.status(400).json({ error: "Post title is required." });
    }

    if (!department) {
      return res.status(400).json({ error: "Department is required." });
    }

    // Parse store CSV - one store ID per line
    const csv = req.files.csv[0].buffer.toString("utf8");
    const csvIds = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (csvIds.length === 0) {
      return res.status(400).json({ error: "Store CSV file is empty." });
    }

    // Parse task CSV (optional for now until task creation is fixed)
    let tasks = [];
    if (req.files && req.files.taskCsv && req.files.taskCsv[0]) {
      tasks = parseTaskCSV(req.files.taskCsv[0].buffer);
      if (tasks.length === 0) {
        console.warn("Task CSV file is empty or has invalid format, continuing without tasks");
      }
    } else {
      console.log("No task CSV provided, creating post without tasks");
    }

    // Look up users by their hidden profile attribute
    const userIds = [];
    for (const csvId of csvIds) {
      const user = await findUserByHiddenId(csvId);
      if (user) {
        userIds.push(user.id);
      }
    }

    if (userIds.length === 0) {
      return res.status(404).json({
        error: `No users found with ${HIDDEN_ATTRIBUTE_KEY} matching CSV IDs.`
      });
    }

    // Generate external ID for channel naming
    const externalId = Date.now();
    
    // Create news channel with user IDs as accessors and [external] prefix
    const channel = await createNewsChannel({
      spaceId: STAFFBASE_SPACE_ID,
      title,
      userIds,
      externalId
    });

    // Create news post in the channel
    const post = await createNewsPost(channel.channelId, title, department);

    // Create task lists in matching store projects
    const taskListResults = await createMultiStoreTaskLists(csvIds, title, tasks);
    const allTaskLists = taskListResults._allTaskLists || [];

    // For persistence in channel name, use the first task list ID (if available)
    const firstTaskListId = allTaskLists.length > 0 ? allTaskLists[0].listId : "unknown";
    
    // Store all task lists info as JSON in metadata
    const taskListsMetadata = JSON.stringify(allTaskLists);

    // Rename channel to include post ID, task list metadata and department for persistence
    const renamedChannel = await renameChannelWithPostInfo(STAFFBASE_SPACE_ID, channel.channelId, externalId, userIds.length, post.id, taskListsMetadata, department, title);

    res.json({
      success: true,
      channelId: channel.channelId,
      postId: post.id,
      taskListResults: taskListResults,
      userCount: userIds.length,
      postTitle: title,
      department,
      externalId,
      taskCount: tasks.length,
      tasksCreatedCount: allTaskLists.length
    });

  } catch (err) {
    console.error("API Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET post status endpoint (proxy to avoid CORS issues)
app.get("/api/post-status/:postId", async (req, res) => {
  try {
    const { postId } = req.params;
    const postUrl = `${STAFFBASE_BASE_URL}/posts/${postId}`;
    
    console.log(`Fetching post status for ${postId} from: ${postUrl}`);
    
    const response = await fetch(postUrl, {
      method: "GET",
      headers: {
        Authorization: STAFFBASE_TOKEN,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      console.error(`Post status fetch failed with status ${response.status}`);
      const errorText = await response.text();
      console.error(`Response: ${errorText}`);
      return res.status(response.status).json({ error: `Failed to fetch post status: ${response.status}` });
    }

    const postData = await response.json();
    
    // Check if post has a future planned date
    let plannedDateFormatted = null;
    let isFutureScheduled = false;
    
    if (postData.planned) {
      const plannedDate = new Date(postData.planned);
      const now = new Date();
      // If planned date is in the future, treat as scheduled
      if (plannedDate > now) {
        isFutureScheduled = true;
        plannedDateFormatted = plannedDate.toLocaleString('en-US', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
    }
    
    // Determine final status
    let published = null;
    let planned = null;
    
    if (isFutureScheduled) {
      // If scheduled for future, mark as planned
      planned = postData.planned;
    } else if (postData.published) {
      // Otherwise if published, mark as published
      published = postData.published;
    }
    // else: it's a draft (neither published nor future-scheduled)
    
    res.json({
      published: published,
      planned: planned,
      plannedDateFormatted: plannedDateFormatted
    });

  } catch (err) {
    console.error("Failed to fetch post status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

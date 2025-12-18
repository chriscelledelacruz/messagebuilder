const form = document.getElementById("form");
const list = document.getElementById("list");
const status = document.getElementById("status");

// File input elements
const csvInput = document.getElementById("csv");
const taskCsvInput = document.getElementById("taskCsv");
const csvFileName = document.getElementById("csvFileName");
const taskCsvFileName = document.getElementById("taskCsvFileName");

// Update file name display
if (csvInput) {
  csvInput.addEventListener("change", () => {
    csvFileName.textContent = csvInput.files.length > 0 ? csvInput.files[0].name : "No file selected";
  });
}

if (taskCsvInput) {
  taskCsvInput.addEventListener("change", () => {
    taskCsvFileName.textContent = taskCsvInput.files.length > 0 ? taskCsvInput.files[0].name : "No file selected";
  });
}

// Filter and sort elements
const filterDepartment = document.getElementById("filterDepartment");
const filterTitle = document.getElementById("filterTitle");
const sortOrder = document.getElementById("sortOrder");
const filterDateFrom = document.getElementById("filterDateFrom");
const filterDateTo = document.getElementById("filterDateTo");
const filterStatus = document.getElementById("filterStatus");
const resetFilters = document.getElementById("resetFilters");
const toggleFiltersBtn = document.getElementById("toggleFilters");
const filtersContainer = document.getElementById("filtersContainer");

// Store all items for filtering
let allItems = [];

// Filter and render items
function filterAndRenderItems() {
  const department = filterDepartment.value;
  const titleSearch = filterTitle.value.toLowerCase();
  const sort = sortOrder.value;
  const dateFrom = filterDateFrom.value ? new Date(filterDateFrom.value) : null;
  const dateTo = filterDateTo.value ? new Date(filterDateTo.value) : null;
  const status = filterStatus.value;

  // Filter items
  let filtered = allItems.filter(item => {
    // Department filter
    if (department && item.department !== department) return false;

    // Title filter
    if (titleSearch && !item.title.toLowerCase().includes(titleSearch)) return false;

    // Date range filter
    const itemDate = new Date(item.createdAt);
    if (dateFrom && itemDate < dateFrom) return false;
    if (dateTo) {
      // Include the entire day for "to" date
      const nextDay = new Date(dateTo);
      nextDay.setDate(nextDay.getDate() + 1);
      if (itemDate >= nextDay) return false;
    }

    // Status filter - check the item's status property
    if (status) {
      if (status !== item.status) return false;
    }

    return true;
  });

  // Sort items
  filtered.sort((a, b) => {
    // If no status filter is set, prioritize draft posts first
    if (!status) {
      const statusOrder = { 'draft': 0, 'scheduled': 1, 'published': 2 };
      const statusA = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
      const statusB = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
      
      if (statusA !== statusB) {
        return statusA - statusB;
      }
    }
    
    // Then sort by date
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return sort === "desc" ? dateB - dateA : dateA - dateB;
  });

  // Clear and render
  list.innerHTML = "";
  if (filtered.length === 0) {
    list.innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">No items match your filters</div>';
    return;
  }

  // Render items sequentially to maintain order
  (async () => {
    for (const item of filtered) {
      await renderItem(item);
    }
    
    // After all items are rendered and their statuses are fetched, re-sort if needed
    if (!status) {
      // Re-sort the filtered items by status, then render in the correct order
      const statusOrder = { 'draft': 0, 'scheduled': 1, 'published': 2 };
      filtered.sort((a, b) => {
        const statusA = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 3;
        const statusB = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 3;
        
        if (statusA !== statusB) {
          return statusA - statusB;
        }
        
        // If same status, sort by date
        const dateA = new Date(a.createdAt);
        const dateB = new Date(b.createdAt);
        return sort === "desc" ? dateB - dateA : dateA - dateB;
      });
      
      // Clear and re-render in correct order
      list.innerHTML = "";
      for (const item of filtered) {
        await renderItem(item);
      }
    }
    
    attachDeleteListeners();
  })();
}

// Render a single item
async function renderItem(item) {
  const itemDiv = document.createElement("div");
  itemDiv.className = "item";
  const createdAt = new Date(item.createdAt).toLocaleString();
  
  let postsHtml = '';
  if (item.posts && item.posts.length > 0) {
    postsHtml = item.posts.map(p => {
      const editUrl = `https://app.staffbase.com/admin/plugin/news/${item.channelId}/${p.postId}/edit?utm_source=in-app&utm_medium=unknown`;
      const taskListUrl = `https://app.staffbase.com/content/tasks/6928e52b8ab88d050a766902`;
      return `
        <div class="item-detail">
          Post: <code>${p.postId}</code>
          <a href="${editUrl}" target="_blank" class="post-link">Edit</a>
          <button class="btn-delete-post" data-channel-id="${item.channelId}" data-task-list-id="${item.taskListId || ''}">Delete</button>
          <div class="post-status" data-post-id="${p.postId}" style="display: inline-block; margin-left: 8px; opacity: 0.7;"><span class="tag-loading">Loading...</span></div>
        </div>
      `;
    }).join('');
  } else if (item.externalId) {
    postsHtml = `
      <div class="item-detail">
        <button class="btn-delete-post" data-channel-id="${item.channelId}" data-task-list-id="${item.taskListId || ''}">Delete Channel</button>
      </div>
    `;
  }
  
  itemDiv.innerHTML = `
    <div class="item-title"><strong>${item.title}</strong></div>
    <div class="item-detail">External ID: <code>${item.externalId}</code></div>
    <div class="item-detail">Department: ${item.department || "Unknown"}</div>
    <div class="item-detail">Users: ${item.userCount}</div>
    <div class="item-detail">Channel ID: <code>${item.channelId}</code></div>
    ${postsHtml}
    <div class="item-detail item-timestamp">${createdAt}</div>
  `;
  
  list.appendChild(itemDiv);

  // Fetch post status for each post
  if (item.posts && item.posts.length > 0) {
    for (const p of item.posts) {
      try {
        const res = await fetch(`/api/post-status/${p.postId}`);
        const postData = await res.json();
        
        const statusDiv = itemDiv.querySelector(`[data-post-id="${p.postId}"]`);
        if (statusDiv) {
          // Determine status based on published and planned fields
          const isPublished = !!postData.published;
          const isScheduled = postData.planned && !postData.published;
          
          let tagClass = 'tag-draft';
          let tagText = 'Draft';
          let statusValue = 'draft';
          
          if (isPublished) {
            tagClass = 'tag-published';
            tagText = 'Published';
            statusValue = 'published';
          } else if (isScheduled) {
            tagClass = 'tag-scheduled';
            tagText = `Scheduled - ${postData.plannedDateFormatted}`;
            statusValue = 'scheduled';
          }
          
          // Store status in item for filtering
          item.status = statusValue;
          
          statusDiv.innerHTML = `<span class="status-tag ${tagClass}">${tagText}</span>`;
        }
      } catch (err) {
        console.error(`Failed to fetch post status for ${p.postId}:`, err);
        const statusDiv = itemDiv.querySelector(`[data-post-id="${p.postId}"]`);
        if (statusDiv) {
          statusDiv.innerHTML = '<span class="status-tag tag-error">Error</span>';
        }
        // Default to draft on error
        item.status = 'draft';
      }
    }
  }
}

// Store delete context for confirmation modal
let pendingDelete = null;

// Helper function to attach delete button listeners
function attachDeleteListeners() {
  document.querySelectorAll(".btn-delete-post").forEach(btn => {
    // Remove existing listeners by cloning
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    
    newBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const channelId = e.target.dataset.channelId;
      const taskListId = e.target.dataset.taskListId;
      
      // Show confirmation via inline status message instead of popup
      const confirmDelete = confirm("Are you sure you want to delete this channel and all its posts?");
      
      if (!confirmDelete) return;
      
      try {
        status.textContent = "Deleting...";
        status.className = "status-processing";
        
        const deleteUrl = taskListId ? `/api/delete/${channelId}?taskListId=${taskListId}` : `/api/delete/${channelId}`;
        const res = await fetch(deleteUrl, { method: "DELETE" });
        const data = await res.json();
        
        if (data.success) {
          status.textContent = "✓ Channel deleted successfully!";
          status.className = "status-success";
          setTimeout(() => location.reload(), 1500);
        } else {
          status.textContent = "✗ Error: " + (data.error || "Unknown error");
          status.className = "status-error";
        }
      } catch (err) {
        status.textContent = "✗ Error deleting channel: " + err.message;
        status.className = "status-error";
      }
    });
  });
}

// Load persisted items on page load
async function loadPersistedItems() {
  try {
    const res = await fetch("/api/items");
    const data = await res.json();
    
    if (!data.items || data.items.length === 0) {
      allItems = [];
      list.innerHTML = '<div style="color: #999;">No created posts yet.</div>';
      return;
    }

    // Store all items for filtering
    allItems = data.items;
    
    // Show all items initially, then render and they will be sorted by status (draft first)
    filterStatus.value = "";
    
    // Render with filters applied
    filterAndRenderItems();
  } catch (err) {
    console.error("Failed to load persisted items:", err);
  }
}

// Attach event listeners to filter controls
filterDepartment.addEventListener("change", filterAndRenderItems);
filterTitle.addEventListener("input", filterAndRenderItems);
sortOrder.addEventListener("change", filterAndRenderItems);
filterDateFrom.addEventListener("change", filterAndRenderItems);
filterDateTo.addEventListener("change", filterAndRenderItems);
filterStatus.addEventListener("change", filterAndRenderItems);
resetFilters.addEventListener("click", () => {
  filterDepartment.value = "";
  filterTitle.value = "";
  sortOrder.value = "desc";
  filterDateFrom.value = "";
  filterDateTo.value = "";
  filterStatus.value = "draft";
  filterAndRenderItems();
});

// Toggle filters visibility
toggleFiltersBtn.addEventListener("click", () => {
  const isHidden = filtersContainer.style.display === "none";
  if (isHidden) {
    filtersContainer.style.display = "grid";
    toggleFiltersBtn.textContent = "Hide Filters";
  } else {
    filtersContainer.style.display = "none";
    toggleFiltersBtn.textContent = "Show Filters";
  }
});

// Load items on page load
document.addEventListener("DOMContentLoaded", loadPersistedItems);

// Store for verification flow
let pendingFormData = null;

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const csvFile = document.getElementById("csv").files[0];
  const taskCsvFile = document.getElementById("taskCsv").files[0];
  const title = document.getElementById("title").value.trim();
  const department = document.getElementById("department").value;
  const notify = document.getElementById("notify").checked;

  // Validate inputs
  if (!csvFile) {
    status.textContent = "Error: Please select a store CSV file.";
    status.className = "status-error";
    return;
  }

  if (!title) {
    status.textContent = "Error: Please enter a post title.";
    status.className = "status-error";
    return;
  }

  if (!department) {
    status.textContent = "Error: Please select a department.";
    status.className = "status-error";
    return;
  }

  // First, verify the users
  const verifyFormData = new FormData();
  verifyFormData.append("csv", csvFile);

  status.textContent = "Verifying users…";
  status.className = "status-processing";

  try {
    const res = await fetch("/api/verify-users", {
      method: "POST",
      body: verifyFormData
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to verify users");
    }

    // Show verification modal
    showVerificationModal(data, csvFile, taskCsvFile, title, department, notify);

  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
});

// Show verification modal
function showVerificationModal(verificationData, csvFile, taskCsvFile, title, department, notify) {
  const modal = document.getElementById("verificationModal");
  const content = document.getElementById("verificationContent");
  
  let html = '';
  
  if (verificationData.totalNotFound > 0) {
    html += `<div class="error-count">⚠️ ${verificationData.totalNotFound} ID(s) not found in Staffbase</div>`;
  }
  
  html += '<div class="user-list">';
  
  // Show found stores
  if (verificationData.foundUsers.length > 0) {
    html += '<strong style="color: #28a745;">✓ Found Stores:</strong>';
    verificationData.foundUsers.forEach(user => {
      html += `
        <div class="user-item">
          <div class="user-item-id">${user.csvId}</div>
          <div class="user-item-name">${user.name}</div>
        </div>
      `;
    });
  }
  
  // Show not found IDs
  if (verificationData.notFoundIds.length > 0) {
    html += '<strong style="color: #dc3545; margin-top: 15px; display: block;">✗ Not Found in Staffbase:</strong>';
    verificationData.notFoundIds.forEach(id => {
      html += `
        <div class="user-item error">
          <div class="user-item-id">${id}</div>
          <div class="user-item-name">No matching store</div>
        </div>
      `;
    });
  }
  
  html += '</div>';
  
  content.innerHTML = html;
  modal.style.display = "flex";
  
  // Store the data for confirmation
  pendingFormData = { csvFile, taskCsvFile, title, department, notify, foundUserCount: verificationData.foundUsers.length };
  
  const confirmBtn = document.getElementById("confirmUsers");
  const cancelBtn = document.getElementById("cancelVerification");
  
  confirmBtn.onclick = () => proceedWithCreation();
  cancelBtn.onclick = () => {
    modal.style.display = "none";
    status.textContent = "";
    status.className = "";
  };
}

// Proceed with creation after verification
async function proceedWithCreation() {
  const modal = document.getElementById("verificationModal");
  modal.style.display = "none";
  
  const { csvFile, taskCsvFile, title, department, notify } = pendingFormData;

  // Prepare form data for creation
  const formData = new FormData();
  formData.append("csv", csvFile);
  // Only append taskCsv if it exists
  if (taskCsvFile) {
    formData.append("taskCsv", taskCsvFile);
  }
  formData.append("title", title);
  formData.append("department", department);
  formData.append("notify", notify);

  status.textContent = "Processing… Creating post.";
  status.className = "status-processing";

  try {
    const res = await fetch("/api/create", {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || "Unknown error occurred");
    }

    status.textContent = "✓ Created successfully!";
    status.className = "status-success";

    // Add item to list
    const item = document.createElement("div");
    item.className = "item";
    const timestamp = new Date().toLocaleString();
    const editUrl = `https://app.staffbase.com/admin/plugin/news/${data.channelId}/${data.postId}/edit?utm_source=in-app&utm_medium=unknown`;
    const taskListUrl = `https://app.staffbase.com/content/tasks/6928e52b8ab88d050a766902`;
    
    item.innerHTML = `
      <div class="item-title"><strong>${data.postTitle}</strong></div>
      <div class="item-detail">External ID: <code>${data.externalId}</code></div>
      <div class="item-detail">Department: ${data.department}</div>
      <div class="item-detail">Users: ${data.userCount}</div>
      <div class="item-detail">Channel ID: <code>${data.channelId}</code></div>
      <div class="item-detail">
        Post ID: <code>${data.postId}</code>
        <a href="${editUrl}" target="_blank" class="post-link">Edit</a>
        <button class="btn-delete-post" data-channel-id="${data.channelId}" data-task-list-id="${data.taskListId || ''}">Delete</button>
      </div>
      <div class="item-detail item-timestamp">${timestamp}</div>
    `;

    // Add to allItems for filtering
    const newItem = {
      channelId: data.channelId,
      title: data.postTitle,
      externalId: data.externalId,
      userCount: data.userCount,
      department: data.department,
      taskListId: data.taskListId || null,
      createdAt: new Date().toISOString(),
      posts: [{ postId: data.postId }],
      status: 'draft' // Default new posts to draft status
    };
    allItems.unshift(newItem);
    
    // Re-render with filters
    filterAndRenderItems();

    // Reset form
    form.reset();

  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
}

const form = document.getElementById("form");
const list = document.getElementById("list");
const status = document.getElementById("status");
const profileCsvInput = document.getElementById("profileCsv");
const profileCsvFileName = document.getElementById("profileCsvFileName");

// File input listeners
const taskCsvInput = document.getElementById("taskCsv");
const taskCsvFileName = document.getElementById("taskCsvFileName");
if (taskCsvInput) {
  taskCsvInput.addEventListener("change", () => {
    taskCsvFileName.textContent = taskCsvInput.files.length > 0 ? taskCsvInput.files[0].name : "No file selected";
  });
}

// --- DYNAMIC TASK FORM LOGIC ---
const manualTasksContainer = document.getElementById("manualTasksContainer");
const addTaskBtn = document.getElementById("addTaskBtn");

// Initialize with one row
addTaskRow();

addTaskBtn.addEventListener("click", addTaskRow);

function addTaskRow() {
    const div = document.createElement("div");
    div.className = "manual-task-row";
    div.innerHTML = `
        <input type="text" placeholder="Task Title" class="t-title" required>
        <input type="text" placeholder="Description" class="t-desc">
        <input type="date" class="t-date" title="Due Date">
        <button type="button" class="btn-icon btn-remove" title="Remove">&times;</button>
    `;
    
    // Remove handler
    div.querySelector(".btn-remove").addEventListener("click", () => {
        // Only allow removing if more than one row, or just clear it?
        // User asked to "add more as needed", keeping it simple: allow delete.
        // If it's the last one, maybe just clear inputs? Let's just remove it.
        if (manualTasksContainer.children.length > 1) {
            div.remove();
        } else {
            div.querySelector('.t-title').value = '';
            div.querySelector('.t-desc').value = '';
            div.querySelector('.t-date').value = '';
        }
    });

    manualTasksContainer.appendChild(div);
}

function getManualTasks() {
    const rows = manualTasksContainer.querySelectorAll(".manual-task-row");
    const tasks = [];
    rows.forEach(row => {
        const title = row.querySelector(".t-title").value.trim();
        const desc = row.querySelector(".t-desc").value.trim();
        const date = row.querySelector(".t-date").value;
        
        if (title) {
            tasks.push({
                title: title,
                description: desc,
                dueDate: date || null
            });
        }
    });
    return tasks;
}

// --- SMART SEARCH & PAGINATION LOGIC ---
let validStores = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 5;

document.getElementById('verifyBtn').addEventListener('click', verifyStores);
document.getElementById('prevPageBtn').addEventListener('click', () => changePage(-1));
document.getElementById('nextPageBtn').addEventListener('click', () => changePage(1));

async function verifyStores() {
  const rawInput = document.getElementById('storeInput').value;
  const resultsContainer = document.getElementById('resultsContainer');
  const countMsg = document.getElementById('storeCountMsg');
  const btn = document.getElementById('verifyBtn');

  validStores = [];
  resultsContainer.style.display = 'none';
  countMsg.textContent = '';
  status.textContent = '';
  status.className = '';

  if (!rawInput.trim()) {
    status.textContent = "Please enter Store IDs to verify.";
    status.className = "status-error";
    return;
  }

  const searchIds = rawInput.split(/[\s,]+/).filter(Boolean);
  const uniqueIds = [...new Set(searchIds)];

  btn.textContent = "Verifying...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/verify-users", {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeIds: uniqueIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");

    validStores = data.foundUsers;
    const notFoundCount = data.notFoundIds.length;
    
    if (notFoundCount > 0) {
        const errorList = data.notFoundIds.join(', ');
        if (validStores.length === 0) {
             status.textContent = `✗ No valid stores found. IDs not found: ${errorList}`;
             status.className = "status-error";
        } else {
             status.textContent = `⚠️ Warning: ${notFoundCount} IDs not found: ${errorList}`;
             status.className = "status-error"; 
        }
    } else if (validStores.length > 0) {
        status.textContent = "✓ All stores verified successfully.";
        status.className = "status-success";
    }

    if (validStores.length > 0) {
      resultsContainer.style.display = 'block';
      currentPage = 1;
      renderStoreTable();
      countMsg.textContent = `✓ Found ${validStores.length} valid stores ready for targeting.`;
    } 

  } catch (err) {
    status.textContent = "Error: " + err.message;
    status.className = "status-error";
  } finally {
    btn.textContent = "Verify Stores";
    btn.disabled = false;
  }
}

function renderStoreTable() {
  const tbody = document.getElementById('storeTableBody');
  tbody.innerHTML = '';
  const start = (currentPage - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageData = validStores.slice(start, end);

  pageData.forEach(store => {
    tbody.innerHTML += `<tr><td><code>${store.csvId}</code></td><td>${store.name}</td><td style="color:var(--se-green); font-weight:bold;">Active</td></tr>`;
  });

  const maxPage = Math.ceil(validStores.length / ITEMS_PER_PAGE) || 1;
  document.getElementById('pageInfo').innerText = `Page ${currentPage} of ${maxPage}`;
  document.getElementById('prevPageBtn').disabled = currentPage === 1;
  document.getElementById('nextPageBtn').disabled = currentPage === maxPage;
}

function changePage(direction) {
  const maxPage = Math.ceil(validStores.length / ITEMS_PER_PAGE);
  if (direction === -1 && currentPage > 1) currentPage--;
  if (direction === 1 && currentPage < maxPage) currentPage++;
  renderStoreTable();
}

// --- FORM SUBMISSION ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const taskCsvFile = document.getElementById("taskCsv").files[0];
  const title = document.getElementById("title").value.trim();
  const department = document.getElementById("department").value;
  const deadline = document.getElementById("deadline").value;
  const notify = document.getElementById("notify").checked;

  // Gather Manual Tasks
  const manualTasks = getManualTasks();

  if (validStores.length === 0) {
    status.textContent = "Error: Please verify at least one valid store before creating a post.";
    status.className = "status-error";
    return;
  }

  status.textContent = "Processing... Creating post and tasks.";
  status.className = "status-processing";

  try {
    const formData = new FormData();
    const storeIds = validStores.map(s => s.csvId);
    
    formData.append("storeIds", JSON.stringify(storeIds));
    formData.append("title", title);
    formData.append("department", department);
    formData.append("deadline", deadline);
    formData.append("notify", notify);
    formData.append("manualTasks", JSON.stringify(manualTasks));
    
    if (taskCsvFile) {
      formData.append("taskCsv", taskCsvFile);
    }

    const res = await fetch("/api/create", {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Unknown error");

    status.textContent = "✓ Success! Reloading...";
    status.className = "status-success";
    setTimeout(() => location.reload(), 1500);

  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
});

// --- PAST SUBMISSIONS LIST ---
const filterDepartment = document.getElementById("filterDepartment");
const filterTitle = document.getElementById("filterTitle");
const filterStatus = document.getElementById("filterStatus");
const filterStoreId = document.getElementById("filterStoreId"); // New
const applyFilters = document.getElementById("applyFilters"); // New button used to trigger fetch
const resetFilters = document.getElementById("resetFilters");
const toggleFiltersBtn = document.getElementById("toggleFilters");
const filtersContainer = document.getElementById("filtersContainer");

let allItems = [];

async function loadPersistedItems() {
  const storeIdVal = filterStoreId.value.trim();
  let url = "/api/items";
  if (storeIdVal) {
      url += `?storeId=${encodeURIComponent(storeIdVal)}`;
  }
  
  // Show loading state if filtering
  list.innerHTML = '<div style="text-align:center; padding:20px;">Loading...</div>';

  try {
    const res = await fetch(url);
    const data = await res.json();
    allItems = data.items || [];
    filterAndRenderItems();
  } catch (err) { 
      console.error(err); 
      list.innerHTML = '<div style="text-align:center; color:red;">Error loading items</div>';
  }
}

function filterAndRenderItems() {
  const dept = filterDepartment.value;
  const txt = filterTitle.value.toLowerCase();
  const stat = filterStatus.value;
  
  let filtered = allItems.filter(item => {
    if (dept && item.department !== dept) return false;
    if (txt && !item.title.toLowerCase().includes(txt)) return false;
    if (stat && stat !== 'draft' && item.status.toLowerCase() !== stat) return false; 
    return true;
  });

  list.innerHTML = "";
  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">No past submissions found</div>';
    return;
  }

  filtered.forEach(item => {
    const div = document.createElement("div");
    const safeCat = (item.department || "Uncategorized").replace(/\s+/g, '');
    div.className = `item cat-${safeCat}`; 
    
    const editUrl = `https://app.staffbase.com/admin/plugin/news/${item.channelId}/posts`;
    let badgeClass = "tag-draft";
    if (item.status === "Published") badgeClass = "tag-published";
    if (item.status === "Scheduled") badgeClass = "tag-scheduled";

    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
        <div class="item-title" style="margin:0;"><strong>${item.title}</strong></div>
        <span class="status-tag ${badgeClass}">${item.status}</span>
      </div>
      <div class="item-detail">
        Category: <span class="cat-badge cat-${safeCat}">${item.department || "Uncategorized"}</span> 
        | Stores: ${item.userCount}
      </div>
      <div class="item-detail">
        <a href="${editUrl}" target="_blank" class="post-link">Edit Post</a>
        <button class="btn-delete-post" data-id="${item.channelId}">Delete</button>
      </div>
      <div class="item-timestamp">${new Date(item.createdAt).toLocaleString()}</div>
    `;
    list.appendChild(div);
  });
  
  attachDeleteListeners();
}

function attachDeleteListeners() {
  document.querySelectorAll(".btn-delete-post").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      if(!confirm("Delete this channel and its posts?")) return;
      await fetch(`/api/delete/${e.target.dataset.id}`, { method: "DELETE" });
      location.reload();
    });
  });
}

// Event Listeners for Filters
// For text inputs, we usually wait for user to finish or click apply.
// Since StoreID requires a server fetch, we use the "Apply" button or Enter key.

applyFilters.addEventListener("click", loadPersistedItems);
filterStoreId.addEventListener("keypress", (e) => {
    if (e.key === 'Enter') loadPersistedItems();
});

// Existing client-side filters can still be immediate
filterDepartment.addEventListener("change", filterAndRenderItems);
filterTitle.addEventListener("input", filterAndRenderItems);
filterStatus.addEventListener("change", filterAndRenderItems);

resetFilters.addEventListener("click", () => {
  filterDepartment.value = ""; 
  filterTitle.value = ""; 
  filterStatus.value = "draft";
  filterStoreId.value = "";
  loadPersistedItems(); // Reload full list
});

toggleFiltersBtn.addEventListener("click", () => {
  filtersContainer.style.display = filtersContainer.style.display === "none" ? "grid" : "none";
});

document.addEventListener("DOMContentLoaded", loadPersistedItems);

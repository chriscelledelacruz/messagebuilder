const form = document.getElementById("form");
const list = document.getElementById("list");
const status = document.getElementById("status");

// File input elements
const taskCsvInput = document.getElementById("taskCsv");
const taskCsvFileName = document.getElementById("taskCsvFileName");

// Update file name display for Task CSV
if (taskCsvInput) {
  taskCsvInput.addEventListener("change", () => {
    taskCsvFileName.textContent = taskCsvInput.files.length > 0 ? taskCsvInput.files[0].name : "No file selected";
  });
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

  // Reset
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

  // 1. Parse IDs from text (Smart Search)
  const searchIds = rawInput.split(/[\s,]+/).filter(Boolean);
  const uniqueIds = [...new Set(searchIds)];

  btn.textContent = "Verifying...";
  btn.disabled = true;

  try {
    // 2. Send IDs to backend as JSON
    const res = await fetch("/api/verify-users", {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeIds: uniqueIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");

    // 3. Handle Results
    validStores = data.foundUsers;
    
    // Show results UI
    if (validStores.length > 0) {
      resultsContainer.style.display = 'block';
      currentPage = 1;
      renderStoreTable();
      countMsg.textContent = `✓ Found ${validStores.length} valid stores.`;
      
      if (data.notFoundIds.length > 0) {
        status.textContent = `⚠️ Warning: ${data.notFoundIds.length} IDs were not found: ${data.notFoundIds.join(', ')}`;
        status.className = "status-error";
      } else {
        status.textContent = "✓ All stores verified successfully.";
        status.className = "status-success";
      }
    } else {
      status.textContent = "✗ No valid stores found matching those IDs.";
      status.className = "status-error";
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
    const row = `<tr>
      <td><code>${store.csvId}</code></td>
      <td>${store.name}</td>
      <td style="color:var(--se-green); font-weight:bold;">Active</td>
    </tr>`;
    tbody.innerHTML += row;
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
  const notify = document.getElementById("notify").checked;

  if (validStores.length === 0) {
    status.textContent = "Error: Please verify at least one valid store before creating a post.";
    status.className = "status-error";
    return;
  }

  status.textContent = "Processing... Creating post.";
  status.className = "status-processing";

  try {
    // Prepare FormData
    // We send storeIds as a JSON string inside the FormData since we might also have a file
    const formData = new FormData();
    const storeIds = validStores.map(s => s.csvId);
    
    formData.append("storeIds", JSON.stringify(storeIds));
    formData.append("title", title);
    formData.append("department", department);
    formData.append("notify", notify);
    
    if (taskCsvFile) {
      formData.append("taskCsv", taskCsvFile);
    }

    const res = await fetch("/api/create", {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Unknown error");

    status.textContent = "✓ Created successfully!";
    status.className = "status-success";
    
    // Refresh list logic (same as before)
    setTimeout(() => location.reload(), 1500);

  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
});

// --- EXISTING LIST LOGIC BELOW (Unchanged functionality, just preserved) ---
const filterDepartment = document.getElementById("filterDepartment");
const filterTitle = document.getElementById("filterTitle");
const sortOrder = document.getElementById("sortOrder");
const filterDateFrom = document.getElementById("filterDateFrom");
const filterDateTo = document.getElementById("filterDateTo");
const filterStatus = document.getElementById("filterStatus");
const resetFilters = document.getElementById("resetFilters");
const toggleFiltersBtn = document.getElementById("toggleFilters");
const filtersContainer = document.getElementById("filtersContainer");

let allItems = [];

async function loadPersistedItems() {
  try {
    const res = await fetch("/api/items");
    const data = await res.json();
    allItems = data.items || [];
    filterAndRenderItems();
  } catch (err) { console.error(err); }
}

function filterAndRenderItems() {
  const dept = filterDepartment.value;
  const txt = filterTitle.value.toLowerCase();
  const stat = filterStatus.value;
  
  let filtered = allItems.filter(item => {
    if (dept && item.department !== dept) return false;
    if (txt && !item.title.toLowerCase().includes(txt)) return false;
    if (stat && stat !== 'draft' && item.status !== stat) return false; // Simple check
    return true;
  });

  list.innerHTML = "";
  if (filtered.length === 0) {
    list.innerHTML = '<div style="text-align:center; color:#999; padding:20px;">No items found</div>';
    return;
  }

  filtered.forEach(item => {
    const div = document.createElement("div");
    div.className = "item";
    const editUrl = `https://app.staffbase.com/admin/plugin/news/${item.channelId}/posts`;
    
    div.innerHTML = `
      <div class="item-title"><strong>${item.title}</strong></div>
      <div class="item-detail">Dept: ${item.department} | Users: ${item.userCount}</div>
      <div class="item-detail">ID: <code>${item.channelId}</code> 
        <a href="${editUrl}" target="_blank" class="post-link">Edit</a>
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
      if(!confirm("Delete this channel?")) return;
      await fetch(`/api/delete/${e.target.dataset.id}`, { method: "DELETE" });
      location.reload();
    });
  });
}

// Event Listeners
filterDepartment.addEventListener("change", filterAndRenderItems);
filterTitle.addEventListener("input", filterAndRenderItems);
filterStatus.addEventListener("change", filterAndRenderItems);
resetFilters.addEventListener("click", () => {
  filterDepartment.value = ""; filterTitle.value = ""; filterStatus.value = "draft";
  filterAndRenderItems();
});
toggleFiltersBtn.addEventListener("click", () => {
  filtersContainer.style.display = filtersContainer.style.display === "none" ? "grid" : "none";
});

document.addEventListener("DOMContentLoaded", loadPersistedItems);

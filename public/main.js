const form = document.getElementById("form");
const list = document.getElementById("list");
const status = document.getElementById("status");

// File input elements
const taskCsvInput = document.getElementById("taskCsv");
const taskCsvFileName = document.getElementById("taskCsvFileName");

// Update file name display
if (taskCsvInput) {
  taskCsvInput.addEventListener("change", () => {
    taskCsvFileName.textContent = taskCsvInput.files.length > 0 ? taskCsvInput.files[0].name : "No file selected";
  });
}

// --- SMART SEARCH LOGIC ---
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
    status.textContent = "Please enter Store IDs.";
    status.className = "status-error";
    return;
  }

  const uniqueIds = [...new Set(rawInput.split(/[\s,]+/).filter(Boolean))];
  btn.textContent = "Verifying...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/verify-users", {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeIds: uniqueIds })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    validStores = data.foundUsers;
    if (validStores.length > 0) {
      resultsContainer.style.display = 'block';
      currentPage = 1;
      renderStoreTable();
      countMsg.textContent = `✓ Found ${validStores.length} valid stores.`;
      status.textContent = data.notFoundIds.length > 0 
        ? `⚠️ Warning: ${data.notFoundIds.length} IDs not found.` 
        : "✓ All verified.";
      status.className = data.notFoundIds.length > 0 ? "status-error" : "status-success";
    } else {
      status.textContent = "✗ No valid stores found.";
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
  
  validStores.slice(start, end).forEach(store => {
    tbody.innerHTML += `<tr><td><code>${store.csvId}</code></td><td>${store.name}</td><td style="color:var(--se-green);font-weight:bold;">Active</td></tr>`;
  });
  
  const maxPage = Math.ceil(validStores.length / ITEMS_PER_PAGE) || 1;
  document.getElementById('pageInfo').innerText = `Page ${currentPage} of ${maxPage}`;
  document.getElementById('prevPageBtn').disabled = currentPage === 1;
  document.getElementById('nextPageBtn').disabled = currentPage === maxPage;
}

function changePage(dir) {
  const maxPage = Math.ceil(validStores.length / ITEMS_PER_PAGE);
  if (dir === -1 && currentPage > 1) currentPage--;
  if (dir === 1 && currentPage < maxPage) currentPage++;
  renderStoreTable();
}

// --- FORM SUBMIT ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (validStores.length === 0) {
    status.textContent = "Please verify stores first.";
    status.className = "status-error";
    return;
  }

  status.textContent = "Creating post and tasks...";
  status.className = "status-processing";

  try {
    const formData = new FormData();
    formData.append("storeIds", JSON.stringify(validStores.map(s => s.csvId)));
    formData.append("title", document.getElementById("title").value.trim());
    formData.append("department", document.getElementById("department").value);
    formData.append("notify", document.getElementById("notify").checked);
    
    if (taskCsvInput.files[0]) formData.append("taskCsv", taskCsvInput.files[0]);

    const res = await fetch("/api/create", { method: "POST", body: formData });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    status.textContent = "✓ Success! Reloading...";
    status.className = "status-success";
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
});

// --- PAST SUBMISSIONS ---
async function loadItems() {
  try {
    const res = await fetch("/api/items");
    const data = await res.json();
    const listDiv = document.getElementById("list");
    listDiv.innerHTML = "";

    if (!data.items || data.items.length === 0) {
      listDiv.innerHTML = '<div style="text-align:center;color:#999;padding:20px;">No past submissions found.</div>';
      return;
    }

    data.items.forEach(item => {
      let badgeClass = "tag-draft";
      if(item.status === "Published") badgeClass = "tag-published";
      if(item.status === "Scheduled") badgeClass = "tag-scheduled";

      const editUrl = `https://app.staffbase.com/admin/plugin/news/${item.channelId}/posts`;

      const el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="item-title" style="margin:0;"><strong>${item.title}</strong></div>
          <span class="status-tag ${badgeClass}">${item.status}</span>
        </div>
        <div class="item-detail" style="margin-top:5px;">
          ${item.department} &bull; ${item.userCount} Stores
        </div>
        <div class="item-detail">
          Channel ID: <code>${item.channelId}</code>
          <a href="${editUrl}" target="_blank" class="post-link">Edit Post</a>
          <button class="btn-delete-post" data-id="${item.channelId}">Delete</button>
        </div>
        <div class="item-timestamp">Created: ${new Date(item.createdAt).toLocaleString()}</div>
      `;
      listDiv.appendChild(el);
    });

    document.querySelectorAll(".btn-delete-post").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        if(!confirm("Delete this channel?")) return;
        await fetch(`/api/delete/${e.target.dataset.id}`, { method: "DELETE" });
        location.reload();
      });
    });

  } catch (err) {
    console.error(err);
  }
}

document.addEventListener("DOMContentLoaded", loadItems);

// ... existing top variables ...
const form = document.getElementById("form");
const list = document.getElementById("list");
const status = document.getElementById("status");
// ... keep existing file input logic ...

// --- VERIFY STORES ---
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
    status.textContent = "Please paste Store IDs first.";
    status.className = "status-error";
    return;
  }

  // Optimize: Clean input before sending
  const searchIds = rawInput.split(/[\s,]+/).filter(Boolean);
  const uniqueIds = [...new Set(searchIds)];

  if (uniqueIds.length > 5000) {
     if(!confirm(`You are verifying ${uniqueIds.length} stores. This might take a moment. Continue?`)) return;
  }

  btn.textContent = "Verifying...";
  btn.disabled = true;

  try {
    const res = await fetch("/api/verify-users", {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeIds: uniqueIds })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");

    validStores = data.foundUsers;
    
    // UI Feedback
    if (validStores.length > 0) {
      resultsContainer.style.display = 'block';
      currentPage = 1;
      renderStoreTable();
      countMsg.textContent = `✓ Found ${validStores.length} valid stores.`;
      
      if (data.notFoundIds.length > 0) {
        // Show partial error
        status.innerHTML = `⚠️ <strong>Warning:</strong> ${data.notFoundIds.length} IDs could not be found.<br>Invalid IDs: ${data.notFoundIds.slice(0, 10).join(', ')}${data.notFoundIds.length > 10 ? '...' : ''}`;
        status.className = "status-error";
      } else {
        status.textContent = "✓ All stores verified successfully.";
        status.className = "status-success";
      }
    } else {
      // Show total error
      status.innerHTML = `✗ <strong>No valid stores found.</strong><br>Checked ${uniqueIds.length} IDs.`;
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

// ... keep existing renderStoreTable, form submit, and loadItems functions ...
// Ensure you copy the 'loadItems' logic from the previous turn if needed, 
// or keep your current one if it works.

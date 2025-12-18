// ... existing code ...

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

  status.textContent = "Processing... Creating post and tasks.";
  status.className = "status-processing";

  try {
    const formData = new FormData();
    
    // CHANGE 1: Send the full 'validStores' object (contains both csvId AND internal id)
    // We send this as a JSON string so the backend can just use the IDs we already found.
    formData.append("verifiedUsers", JSON.stringify(validStores));
    
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

    status.textContent = "✓ Success! Reloading...";
    status.className = "status-success";
    
    setTimeout(() => location.reload(), 1500);

  } catch (err) {
    status.textContent = "✗ Error: " + err.message;
    status.className = "status-error";
  }
});

// ... existing Past Submissions code ...

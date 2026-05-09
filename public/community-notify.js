(function () {
  var body = document.body;
  var username = body.getAttribute("data-username");
  if (!username || !window.EventSource) return;

  var seen = {};
  var seenCount = 0;

  function dedupe(id) {
    if (!id) return false;
    if (seen[id]) return true;
    seen[id] = true;
    seenCount++;
    if (seenCount > 80) {
      seen = {};
      seenCount = 0;
    }
    return false;
  }

  function showToast(message) {
    var t = document.createElement("div");
    t.className = "community-toast";
    t.setAttribute("role", "status");
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 5200);
  }

  function notify(data) {
    if (!data || data.type !== "new_post") return;
    if (data.authorName === username) return;
    if (dedupe(data.postId)) return;

    var preview = (data.textPreview || "").replace(/\s+/g, " ").trim();
    if (preview.length > 100) preview = preview.slice(0, 100) + "…";
    var line =
      "@" +
      data.authorName +
      (preview ? ": " + preview : data.hasImage ? " — new photo" : " — new post");

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("مسکێنەکان · Community", {
          body: line,
          tag: "community-" + (data.postId || ""),
          renotify: true
        });
      } catch (_e) {
        /* ignore */
      }
    }

    showToast(line);
  }

  var es;
  function connectStream() {
    if (es) {
      try {
        es.close();
      } catch (_e) {
        /* ignore */
      }
    }
    es = new EventSource("/community/stream");
    es.onmessage = function (ev) {
      try {
        var data = JSON.parse(ev.data);
        if (data.type === "connected") return;
        notify(data);
      } catch (_e) {
        /* ignore */
      }
    };
    es.onerror = function () {
      try {
        es.close();
      } catch (_e) {
        /* ignore */
      }
      setTimeout(connectStream, 4000);
    };
  }
  connectStream();

  if ("Notification" in window && Notification.permission === "default") {
    document.addEventListener(
      "click",
      function once() {
        document.removeEventListener("click", once);
        Notification.requestPermission().catch(function () {});
      },
      { once: true }
    );
  }
})();

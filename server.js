const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");

dotenv.config();

const app = express();
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const allowedImageMime = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function extFromMime(mime) {
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp"
  };
  return map[mime] || ".jpg";
}

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${extFromMime(file.mimetype)}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedImageMime.has(file.mimetype)) return cb(null, true);
    const err = new Error("INVALID_IMAGE_TYPE");
    err.code = "INVALID_IMAGE_TYPE";
    cb(err);
  }
});

function deleteLocalUpload(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.startsWith("/uploads/")) return;
  const basename = path.basename(imageUrl);
  if (!basename || basename.includes("..")) return;
  const full = path.join(uploadsDir, basename);
  fs.unlink(full, () => {});
}

function safeExternalImageUrl(raw) {
  const u = String(raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return u;
  } catch (_e) {
    return "";
  }
}

/** Uploaded file wins; otherwise optional http(s) URL from the form. */
function resolvePostImageUrl(req) {
  if (req.file) return `/uploads/${req.file.filename}`;
  return safeExternalImageUrl(req.body.imageUrl);
}

function resolveMemberImageUrl(req) {
  if (req.file) return `/uploads/${req.file.filename}`;
  return safeExternalImageUrl(req.body.imageUrl);
}
const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.warn("MONGODB_URI is missing. Add it in your .env file.");
}

const memberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true, lowercase: true },
    imageUrl: { type: String, required: true, trim: true },
    imageText: { type: String, trim: true, maxlength: 80, default: "" }
  },
  { timestamps: true }
);

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, lowercase: true }
  },
  { timestamps: true }
);

const Member = mongoose.model("Member", memberSchema);
const Role = mongoose.model("Role", roleSchema);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    role: { type: String, default: "user", trim: true, lowercase: true }
  },
  { timestamps: true }
);

const postSchema = new mongoose.Schema(
  {
    authorName: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true, maxlength: 500 },
    imageUrl: { type: String, trim: true }
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);
const Post = mongoose.model("Post", postSchema);
const assignableUserRoles = ["user", "msken", "shex", "bag", "admin"];

const starterRoles = ["msken", "shex", "bag"];

const starterMembers = [
  {
    name: "Shex",
    role: "shex",
    imageUrl: "https://i.ibb.co/nwZ9rtJ/shex.jpg"
  },
  {
    name: "Baag",
    role: "bag",
    imageUrl: "https://i.ibb.co/jRkGL6F/baag.jpg",
    imageText: "BAG POWER"
  },
  {
    name: "Msken",
    role: "msken",
    imageUrl: "https://i.ibb.co/c83T5mH/msken.jpg",
    imageText: "MSKEN MODE"
  }
];
let useMemoryStore = false;
let memoryRoles = [...starterRoles];
let memoryMembers = starterMembers.map((member, index) => ({
  ...member,
  _id: `m${index + 1}`
}));
let memoryUsers = [];
let memoryPosts = [];

async function seedData() {
  const roleCount = await Role.countDocuments();
  if (roleCount === 0) {
    await Role.insertMany(starterRoles.map((name) => ({ name })));
  }
  await Promise.all(
    starterRoles.map((name) =>
      Role.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true })
    )
  );

  await Member.updateMany({ role: "leader" }, { role: "bag" });
  await Member.updateMany({ role: "servant" }, { role: "msken" });
  await Member.updateMany({ role: "admin" }, { role: "bag" });

  const memberCount = await Member.countDocuments();
  if (memberCount === 0) {
    await Member.insertMany(starterMembers);
  }

  const adminUser = await User.findOne({ username: "shex" }).lean();
  if (!adminUser) {
    const passwordHash = await bcrypt.hash("123456", 10);
    await User.create({
      username: "shex",
      passwordHash,
      isVerified: true,
      role: "admin"
    });
  }
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "msken-secret-key-change-this",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
  })
);

app.use(async (req, res, next) => {
  res.locals.currentUser = null;
  if (!req.session.userId) return next();

  try {
    if (useMemoryStore) {
      const user = memoryUsers.find((item) => item._id === req.session.userId) || null;
      res.locals.currentUser = user;
      return next();
    }

    const user = await User.findById(req.session.userId).lean();
    res.locals.currentUser = user || null;
    return next();
  } catch (_error) {
    res.locals.currentUser = null;
    return next();
  }
});

async function getAvailableRoles() {
  if (useMemoryStore) {
    return memoryRoles;
  }
  const roles = await Role.find().sort({ name: 1 }).lean();
  return roles.map((role) => role.name);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!res.locals.currentUser || res.locals.currentUser.role !== "admin") {
    return res.status(403).send("Admins only.");
  }
  return next();
}

app.get("/", async (_req, res) => {
  const members = useMemoryStore
    ? [...memoryMembers].sort((a, b) => a.name.localeCompare(b.name))
    : await Member.find().sort({ name: 1, createdAt: 1 }).lean();

  const isPinnedTop = (name) => ["shex", "baag"].includes(String(name).toLowerCase());
  const topMembers = members
    .filter((member) => isPinnedTop(member.name))
    .sort((a, b) => {
      const order = { shex: 0, baag: 1 };
      return order[String(a.name).toLowerCase()] - order[String(b.name).toLowerCase()];
    });
  const bottomMskenms = members.filter((member) => !isPinnedTop(member.name));
  const roles = await getAvailableRoles();

  res.render("index", {
    roles,
    topMembers,
    bottomMskenms
  });
});

app.get("/register", (_req, res) => {
  res.render("register", { error: "" });
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || String(password).length < 6) {
    return res.status(400).render("register", {
      error: "Username and password (min 6 chars) are required."
    });
  }

  const safeUsername = String(username).toLowerCase().trim();
  if (useMemoryStore) {
    const exists = memoryUsers.some((item) => item.username === safeUsername);
    if (exists) {
      return res.status(400).render("register", { error: "Username already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    memoryUsers.push({
      _id: `${Date.now()}`,
      username: safeUsername,
      passwordHash,
      isVerified: false,
      role: "user"
    });
    return res.render("register", {
      error: "Registered! Wait for admin verification before login."
    });
  }

  const exists = await User.findOne({ username: safeUsername }).lean();
  if (exists) {
    return res.status(400).render("register", { error: "Username already exists." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({
    username: safeUsername,
    passwordHash,
    isVerified: false,
    role: "user"
  });

  return res.render("register", {
    error: "Registered! Wait for admin verification before login."
  });
});

app.get("/login", (_req, res) => {
  res.render("login", { error: "" });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).render("login", { error: "Username and password are required." });
  }

  const safeUsername = String(username).toLowerCase().trim();
  const user = useMemoryStore
    ? memoryUsers.find((item) => item.username === safeUsername)
    : await User.findOne({ username: safeUsername });

  if (!user) {
    return res.status(400).render("login", { error: "Invalid credentials." });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(400).render("login", { error: "Invalid credentials." });
  }

  if (!user.isVerified) {
    return res.status(403).render("login", {
      error: "Account not verified yet. Ask admin to approve from database panel."
    });
  }

  req.session.userId = String(user._id);
  return res.redirect("/community");
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

app.get("/community", requireAuth, async (_req, res) => {
  const posts = useMemoryStore
    ? [...memoryPosts].sort((a, b) => b.createdAt - a.createdAt)
    : await Post.find().sort({ createdAt: -1 }).lean();
  res.render("community", { posts });
});

app.post("/community/posts", requireAuth, upload.single("image"), async (req, res) => {
  const text = req.body.text;
  if (!text || !String(text).trim()) {
    if (req.file) deleteLocalUpload(`/uploads/${req.file.filename}`);
    return res.redirect("/community");
  }

  const imageUrl = resolvePostImageUrl(req);
  const authorName = res.locals.currentUser.username;
  if (useMemoryStore) {
    memoryPosts.unshift({
      _id: `${Date.now()}`,
      authorName,
      text: String(text).trim(),
      imageUrl,
      createdAt: new Date()
    });
  } else {
    await Post.create({
      authorName,
      text: String(text).trim(),
      imageUrl
    });
  }
  return res.redirect("/community");
});

app.get("/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const pendingUsers = useMemoryStore
    ? memoryUsers.filter((user) => !user.isVerified)
    : await User.find({ isVerified: false }).sort({ createdAt: 1 }).lean();
  res.render("admin-users", { pendingUsers });
});

app.get("/admin", requireAuth, requireAdmin, async (_req, res) => {
  const pendingUsers = useMemoryStore
    ? memoryUsers.filter((user) => !user.isVerified)
    : await User.find({ isVerified: false }).sort({ createdAt: 1 }).lean();
  const allUsers = useMemoryStore
    ? [...memoryUsers].sort((a, b) => a.username.localeCompare(b.username))
    : await User.find().select("username role isVerified createdAt").sort({ username: 1 }).lean();
  const members = useMemoryStore
    ? [...memoryMembers].sort((a, b) => a.name.localeCompare(b.name))
    : await Member.find().sort({ name: 1, createdAt: 1 }).lean();
  const roles = await getAvailableRoles();

  res.render("admin-panel", {
    pendingUsers,
    allUsers,
    userRoles: assignableUserRoles,
    members,
    roles
  });
});

app.post("/admin/users/:id/verify", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  if (useMemoryStore) {
    memoryUsers = memoryUsers.map((item) =>
      item._id === userId ? { ...item, isVerified: true } : item
    );
  } else {
    await User.findByIdAndUpdate(userId, { isVerified: true });
  }
  return res.redirect("/admin");
});

app.post("/admin/users/:id/role", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const role = String(req.body.role || "").toLowerCase().trim();
  if (!assignableUserRoles.includes(role)) {
    return res.redirect("/admin");
  }

  if (useMemoryStore) {
    memoryUsers = memoryUsers.map((item) =>
      item._id === userId ? { ...item, role } : item
    );
  } else {
    await User.findByIdAndUpdate(userId, { role });
  }
  return res.redirect("/admin");
});

app.post("/members", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  const { name, role, imageText } = req.body;
  const imageUrl = resolveMemberImageUrl(req);

  if (!name || !role || !imageUrl) {
    if (req.file) deleteLocalUpload(`/uploads/${req.file.filename}`);
    return res.redirect("/admin");
  }

  const safeRole = String(role).toLowerCase().trim();
  const roles = await getAvailableRoles();
  if (!roles.includes(safeRole)) {
    if (req.file) deleteLocalUpload(`/uploads/${req.file.filename}`);
    return res.redirect("/admin");
  }

  let member;
  if (useMemoryStore) {
    member = {
      name,
      role: safeRole,
      imageUrl,
      imageText: String(imageText || "").trim(),
      _id: `m-${Date.now()}`
    };
    memoryMembers.push(member);
  } else {
    member = await Member.create({
      name,
      role: safeRole,
      imageUrl,
      imageText: String(imageText || "").trim()
    });
  }
  return res.redirect("/admin");
});

app.post("/members/:id/update", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  const memberId = req.params.id;
  const { name, role, imageText } = req.body;
  const safeRole = String(role || "").toLowerCase().trim();
  const roles = await getAvailableRoles();
  if (!name || !safeRole || !roles.includes(safeRole)) {
    if (req.file) deleteLocalUpload(`/uploads/${req.file.filename}`);
    return res.redirect("/admin");
  }

  let existing = null;
  if (useMemoryStore) {
    existing = memoryMembers.find((m) => String(m._id) === String(memberId)) || null;
  } else {
    existing = await Member.findById(memberId).lean();
  }
  if (!existing) {
    if (req.file) deleteLocalUpload(`/uploads/${req.file.filename}`);
    return res.redirect("/admin");
  }

  let nextImageUrl;
  if (req.file) {
    deleteLocalUpload(existing.imageUrl);
    nextImageUrl = `/uploads/${req.file.filename}`;
  } else {
    const raw = String(req.body.imageUrl || "").trim();
    if (!raw) {
      nextImageUrl = existing.imageUrl || "";
    } else if (raw.startsWith("/uploads/")) {
      nextImageUrl = raw === existing.imageUrl ? raw : existing.imageUrl || "";
    } else {
      const ext = safeExternalImageUrl(raw);
      if (ext) {
        if (ext !== existing.imageUrl && existing.imageUrl && existing.imageUrl.startsWith("/uploads/")) {
          deleteLocalUpload(existing.imageUrl);
        }
        nextImageUrl = ext;
      } else {
        nextImageUrl = existing.imageUrl || "";
      }
    }
  }

  const updates = {
    name: String(name).trim(),
    role: safeRole,
    imageUrl: nextImageUrl,
    imageText: String(imageText || "").trim()
  };

  if (useMemoryStore) {
    memoryMembers = memoryMembers.map((member) =>
      String(member._id) === String(memberId) ? { ...member, ...updates } : member
    );
  } else {
    await Member.findByIdAndUpdate(memberId, updates);
  }
  return res.redirect("/admin");
});

app.post("/members/:id/remove-image", requireAuth, requireAdmin, async (req, res) => {
  const memberId = req.params.id;
  if (useMemoryStore) {
    const member = memoryMembers.find((m) => String(m._id) === String(memberId));
    if (member) deleteLocalUpload(member.imageUrl);
    memoryMembers = memoryMembers.map((m) =>
      String(m._id) === String(memberId) ? { ...m, imageUrl: "", imageText: "" } : m
    );
  } else {
    const member = await Member.findById(memberId).lean();
    if (member) deleteLocalUpload(member.imageUrl);
    await Member.findByIdAndUpdate(memberId, { imageUrl: "", imageText: "" });
  }
  return res.redirect("/admin");
});

app.post("/members/:id/delete", requireAuth, requireAdmin, async (req, res) => {
  const memberId = req.params.id;
  if (useMemoryStore) {
    const member = memoryMembers.find((m) => String(m._id) === String(memberId));
    if (member) deleteLocalUpload(member.imageUrl);
    memoryMembers = memoryMembers.filter((m) => String(m._id) !== String(memberId));
  } else {
    const member = await Member.findById(memberId).lean();
    if (member) deleteLocalUpload(member.imageUrl);
    await Member.findByIdAndDelete(memberId);
  }
  return res.redirect("/admin");
});

app.use((err, req, res, next) => {
  if (err && err.code === "INVALID_IMAGE_TYPE") {
    return res.status(400).send("Only JPEG, PNG, GIF, and WebP images are allowed.");
  }
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).send("Image must be 5 MB or smaller.");
    }
    return res.status(400).send("Could not process the upload.");
  }
  next(err);
});

async function start() {
  try {
    if (mongoUri) {
      await mongoose.connect(mongoUri);
      await seedData();
    } else {
      useMemoryStore = true;
      const adminHash = await bcrypt.hash("123456", 10);
      memoryUsers.push({
        _id: "1",
        username: "shex",
        passwordHash: adminHash,
        isVerified: true,
        role: "admin"
      });
      console.warn("Running with in-memory data because MONGODB_URI is missing.");
    }
  } catch (error) {
    useMemoryStore = true;
    const adminHash = await bcrypt.hash("123456", 10);
    memoryUsers.push({
      _id: "1",
      username: "shex",
      passwordHash: adminHash,
      isVerified: true,
      role: "admin"
    });
    console.warn(`MongoDB unavailable (${error.message}). Running with in-memory data.`);
  }

  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

start();

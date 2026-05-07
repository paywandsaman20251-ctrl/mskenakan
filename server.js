const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const session = require("express-session");
const bcrypt = require("bcryptjs");

dotenv.config();

const app = express();
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

const starterRoles = ["msken", "shex", "bag"];

const starterMembers = [
  {
    _id: "m1",
    name: "Shex",
    role: "shex",
    imageUrl: "https://i.ibb.co/nwZ9rtJ/shex.jpg"
  },
  {
    _id: "m2",
    name: "Baag",
    role: "bag",
    imageUrl: "https://i.ibb.co/jRkGL6F/baag.jpg",
    imageText: "BAG POWER"
  },
  {
    _id: "m3",
    name: "Msken",
    role: "msken",
    imageUrl: "https://i.ibb.co/c83T5mH/msken.jpg",
    imageText: "MSKEN MODE"
  }
];
let useMemoryStore = false;
let memoryRoles = [...starterRoles];
let memoryMembers = [...starterMembers];
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

app.post("/community/posts", requireAuth, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text || !String(text).trim()) {
    return res.redirect("/community");
  }

  const authorName = res.locals.currentUser.username;
  if (useMemoryStore) {
    memoryPosts.unshift({
      _id: `${Date.now()}`,
      authorName,
      text: String(text).trim(),
      imageUrl: String(imageUrl || "").trim(),
      createdAt: new Date()
    });
  } else {
    await Post.create({
      authorName,
      text: String(text).trim(),
      imageUrl: String(imageUrl || "").trim()
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

app.post("/admin/users/:id/verify", requireAuth, requireAdmin, async (req, res) => {
  const userId = req.params.id;
  if (useMemoryStore) {
    memoryUsers = memoryUsers.map((item) =>
      item._id === userId ? { ...item, isVerified: true } : item
    );
  } else {
    await User.findByIdAndUpdate(userId, { isVerified: true });
  }
  return res.redirect("/admin/users");
});

app.post("/members", requireAuth, requireAdmin, async (req, res) => {
  const { name, role, imageUrl, imageText } = req.body;

  if (!name || !role || !imageUrl) {
    return res.status(400).redirect("/");
  }

  const safeRole = String(role).toLowerCase().trim();
  const roles = await getAvailableRoles();
  if (!roles.includes(safeRole)) {
    return res.status(400).redirect("/");
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
  return res.redirect("/");
});

app.post("/members/:id/update", requireAuth, requireAdmin, async (req, res) => {
  const memberId = req.params.id;
  const { name, role, imageUrl, imageText } = req.body;
  const safeRole = String(role || "").toLowerCase().trim();
  const roles = await getAvailableRoles();
  if (!name || !safeRole || !roles.includes(safeRole)) {
    return res.redirect("/");
  }

  const updates = {
    name: String(name).trim(),
    role: safeRole,
    imageUrl: String(imageUrl || "").trim(),
    imageText: String(imageText || "").trim()
  };

  if (useMemoryStore) {
    memoryMembers = memoryMembers.map((member) =>
      String(member._id) === String(memberId) ? { ...member, ...updates } : member
    );
  } else {
    await Member.findByIdAndUpdate(memberId, updates);
  }
  return res.redirect("/");
});

app.post("/members/:id/remove-image", requireAuth, requireAdmin, async (req, res) => {
  const memberId = req.params.id;
  if (useMemoryStore) {
    memoryMembers = memoryMembers.map((member) =>
      String(member._id) === String(memberId) ? { ...member, imageUrl: "", imageText: "" } : member
    );
  } else {
    await Member.findByIdAndUpdate(memberId, { imageUrl: "", imageText: "" });
  }
  return res.redirect("/");
});

app.post("/members/:id/delete", requireAuth, requireAdmin, async (req, res) => {
  const memberId = req.params.id;
  if (useMemoryStore) {
    memoryMembers = memoryMembers.filter((member) => String(member._id) !== String(memberId));
  } else {
    await Member.findByIdAndDelete(memberId);
  }
  return res.redirect("/");
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

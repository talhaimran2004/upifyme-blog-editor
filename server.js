import express from "express";
import mongoose from "mongoose";
import "dotenv/config";
import bcrypt from "bcrypt";
import User from "./Schema/User.js";
import { nanoid } from "nanoid";
import jwt from "jsonwebtoken";
import cors from "cors";
import Blog from "./Schema/Blog.js";
import nodemailer from "nodemailer";
import aws from "aws-sdk";

const server = express();
const PORT = 3000;

const emailRegex = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/; // regex for email
const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{6,20}$/; // regex for password

server.use(express.json());
server.use(cors());
mongoose.connect(process.env.DB_LOCATION, {
  autoIndex: true,
});

// setting up aws
const s3 = new aws.S3({
  region: 'ap-south-1',
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY 
});

const generateUploadURL = async () => {
  const date = new Date();
  const imageName = `${nanoid()}-${date.getTime()}.jpeg`;

  return await s3.getSignedUrlPromise('putObject', {
    Bucket: 'blogging-website-yt-arhum',
    Key: imageName,
    Expires: 1000,
    ContentType: 'image/jpeg'
  });
};

const verifyJWT = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (token == null) {
    return res.status(401).json({ error: "No access token" });
  }

  jwt.verify(token, process.env.SECRET_ACCESS_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Access token is invalid" });
    }

    req.user = user.id;
    next();
  });
};

const formatDatatoSend = (user) => {
  const access_token = jwt.sign(
    { id: user._id },
    process.env.SECRET_ACCESS_KEY
  );
  return {
    access_token,
    profile_img: user.personal_info.profile_img,
    username: user.personal_info.username,
    fullname: user.personal_info.fullname,
  };
};

const generateUsername = async (email) => {
  let username = email.split("@")[0];

  let isUsernameNotUnique = await User.exists({
    "personal_info.username": username,
  }).then((result) => result);

  isUsernameNotUnique ? (username += nanoid().substring(0, 5)) : "";

  return username;
};

server.post("/signup", (req, res) => {
  const { fullname, email, password } = req.body;

  if (fullname.length < 3) {
    return res
      .status(403)
      .json({ error: "Fullname must be at least 3 letters long" });
  }
  if (!email) {
    return res.status(403).json({ error: "Enter Email" });
  }
  if (!emailRegex.test(email)) {
    return res.status(403).json({ error: "Enter Valid Email" });
  }
  if (!passwordRegex.test(password)) {
    return res.status(403).json({
      error:
        "Password Should be 6 to 20 charachters long a numeric 1 lowercase 1 uppercase letters",
    });
  }
  bcrypt.hash(password, 10, async (err, hashed_password) => {
    let username = await generateUsername(email);
    let user = new User({
      personal_info: { fullname, email, password: hashed_password, username },
    });
    user
      .save()
      .then((u) => {
        return res.status(200).json(formatDatatoSend(u));
      })
      .catch((err) => {
        if (err.code == 11000) {
          return res.status(500).json({ error: "Email Already Exists" });
        }
        return res.status(500).json({ error: err.message });
      });
  });
});

server.post("/signin", (req, res) => {
  let { email, password } = req.body;

  User.findOne({ "personal_info.email": email })
    .then((user) => {
      if (!user) {
        return res.status(403).json({ error: "Email not found" });
      }
      bcrypt.compare(password, user.personal_info.password, (err, result) => {
        if (err) {
          return res
            .status(403)
            .json({ error: "Error occured while login please try again" });
        }
        if (!result) {
          return res.status(403).json({ error: "Incorrect password" });
        } else {
          return res.status(200).json(formatDatatoSend(user));
        }
      });
    })
    .catch((err) => {
      console.log(err.message);
      return res.status(500).json({ error: err.message });
    });
});

server.get("/latest-blogs", (req, res) => {
  let maxlimit = 5;

  Blog.find({ draft: false })
    .populate(
      "author",
      "personal_info.profile_img personal_info.username personal_info.fullname -_id"
    )
    .sort({ publishedAt: -1 })
    .select("blog_id title des banner activity tags publishedAt -_id")
    .limit(maxlimit)
    .then((blogs) => {
      return res.status(200).json({ blogs });
    })
    .catch((err) => {
      return res.status(500).json({ error: err.message });
    });
});

server.post("/create-blog", verifyJWT, (req, res) => {
  let authorId = req.user;

  const { title, des, banner, tags, content, draft, id } = req.body;
  if (title.length === 0) {
    return res.status(403).json({ error: "Title cannot be empty" });
  }
  // Validation
  if (!draft) {
    if (!title || !des || !tags || !content) {
      return res.status(403).json({ error: "Incomplete blog data" });
    }

    // if (banner.length === 0) {
    //   return res.status(403).json({ error: 'Must Upload Banner to publish it' });
    // }
    if (des.length === 0 || des.length > 200) {
      return res
        .status(403)
        .json({ error: "Description must be between 1 to 200 characters" });
    }

    if (!Array.isArray(tags) || tags.length === 0 || tags.length > 10) {
      return res
        .status(403)
        .json({ error: "Provide 1 to 10 tags for the blog" });
    }
  }

  const blog_id =
    id ||
    title.replace(/[^a-zA-Z0-9]/g, " ").replace(/\s+/g, "-") + "-" + nanoid();

  if (id) {
    Blog.findOneAndUpdate(
      { blog_id },
      { title, des, banner, content, tags, draft: draft ? draft : false }
    )
      .then(() => {
        return res.status(200).json({ id: blog_id });
      })
      .catch((err) => {
        return res
          .status(500)
          .json({ error: "failed to update total posts numbers" });
      });
  } else {
    let blog = new Blog({
      title,
      des,
      banner,
      content,
      tags,
      author: authorId,
      blog_id,
      draft: Boolean(draft),
    });
    blog.save().then((blog) => {
      let incrementVal = draft ? 0 : 1;

      User.findOneAndUpdate(
        { _id: authorId },
        {
          $inc: { "account_info.total_posts": incrementVal },
          $push: { blogs: blog._id },
        }
      )
        .then((user) => {
          return res.status(200).json({ id: blog.blog_id });
        })
        .catch((err) => {
          return res
            .status(500)
            .json({ error: "Failed to update toltal post number" });
        })
        .catch((err) => {
          return res.status(500).json({ error: err.message });
        });
    });
  }
});

server.get('/get-upload-url', (req, res) => {
  generateUploadURL()
    .then(url => res.status(200).json({ uploadURL: url }))
    .catch(err => {
      console.log(err.message);
      return res.status(500).json({ error: err.message });
    });
});

server.post("/get-blog", (req, res) => {
  let { blog_id, draft, mode } = req.body;

  let incrementVal = mode != "edit" ? 1 : 0;
  Blog.findOneAndUpdate(
    { blog_id },
    { $inc: { "activity.total_reads": incrementVal } }
  )
    .populate(
      "author",
      "personal_info.fullname personal_info.username personal_info.profile_img"
    )
    .then((blog) => {
      User.findOneAndUpdate(
        { "personal_info.username": blog.author.personal_info.username },
        {
          $inc: { "account_info.total_reads": incrementVal },
        }
      ).catch((err) => {
        return res.status(500).json({ error: err.message });
      });
      if (blog.draft && !draft) {
        return res.status(500).json({ error: "you can not acess draft blogs" });
      }
      return res.status(200).json({ blog });
    })

    .catch((err) => {
      return res.status(500).json({ error: err.message });
    });
});
// delete
server.post("/delete-blog", verifyJWT, (req, res) => {
  const { blog_id } = req.body;
  const authorId = req.user;

  // Check if the blog exists and is authored by the user
  Blog.findOne({ blog_id, author: authorId })
    .then((blog) => {
      if (!blog) {
        return res.status(404).json({
          error: "Blog not found or you are not authorized to delete it",
        });
      }
      Blog.deleteOne({ _id: blog._id })
        .then(() => {
          User.updateOne({ _id: authorId }, { $pull: { blogs: blog._id } })
            .then(() => {
              return res
                .status(200)
                .json({ message: "Blog deleted successfully" });
            })
            .catch((err) => {
              return res.status(500).json({ error: err.message });
            });
        })
        .catch((err) => {
          return res.status(500).json({ error: err.message });
        });
    })
    .catch((err) => {
      return res.status(500).json({ error: err.message });
    });
});

// send email
const transporter = nodemailer.createTransport({
  service: "gmail", // e.g., 'gmail'
  auth: {
    user: "memongirach1@gmail.com",
    pass: "lovk uysr pmra rixg",
  },
});

server.post("/submit-form", async (req, res) => {
  const { firstName, phone, email, message } = req.body;

  // Create email content
  const mailOptions = {
    from: "memongirach1@gmail.com",
    to: "recipient@example.com",
    subject: "New Form Submission",
    text: `
      Name: ${firstName}
      Phone: ${phone}
      Email: ${email}
      Message: ${message}
    `,
  };

  try {
    // Send email using Nodemailer
    await transporter.sendMail(mailOptions);
    // console.log("Email sent successfully");
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  }
});

server.listen(PORT, () => {
  console.log("listening on port -->" + PORT);
});

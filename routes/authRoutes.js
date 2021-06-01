const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

//Mailgun js setup
const API_KEY = "30b130ca9331b7f837e13cd9ab9696c5-1d8af1f4-932b6476";
const DOMAIN = "sandbox22577e723c414ba48c1ed115088d376f.mailgun.org";
const mailgun = require("mailgun-js")({ apiKey: API_KEY, domain: DOMAIN });

//Authentication with email and password
router.post("/signup", async (req, res) => {
  try {
    const { email, password, password2 } = req.body;
    console.log(email, password, password2);

    if (
      email === null ||
      password === null ||
      password2 === null ||
      isEmpty(email) ||
      isEmpty(password) ||
      isEmpty(password2)
    ) {
      return res.status(400).send({ error: "Email, and password are required" });
    }
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }
    if (password !== password2) {
      return res.status(400).json({ error: "Passwords do not match, please try again" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query("INSERT INTO users (email, password) VALUES($1, $2) RETURNING *", [
      email,
      hashedPassword,
    ]);
    console.log(result);
    const user = result.rows[0];
    console.log(user);
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

    res.status(200).send({ accessToken, refreshToken, email: user.email });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Invalid email, email already signed up" });
  }
});

router.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email, password);
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }
    if (isEmpty(email) || isEmpty(password)) {
      return res.status(400).send({ error: "Must provide email and password" });
    }

    const result = await pool.query("SELECT * FROM users WHERE users.email=$1", [email]);
    const user = result.rows[0];
    console.log(user);
    if (!user) {
      return res.status(400).send({ error: "Must provide a valid email and password" });
    }
    const isValid = await bcrypt.compare(password, user.password);
    console.log("ISVALID", isValid);
    //passwords don't match
    if (!isValid) {
      res.status(400).send({ error: "Invalid password" });
    }
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

    //add the refresh token to user in database
    await pool.query("UPDATE users SET refresh_token = $1 WHERE id=$2", [refreshToken, user.id]);

    res.status(200).send({
      accessToken,
      refreshToken,
      email: user.email,
      income: user.income,
      savings: user.savings,
      createdBudget: user.created_budget,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to sign in, please try again" });
  }
});

router.post("/token", async (req, res) => {
  try {
    const refreshToken = req.body.token;
    console.log("REFRESH TOKEN", refreshToken);
    if (refreshToken === null) {
      return res.sendStatus(401);
    }

    let result = await pool.query("SELECT refresh_token FROM users WHERE refresh_token=$1", [refreshToken]);
    result = result.rows;
    console.log("RESULT", result);

    //if refresh token can't be found in database then it must be invalid
    if (result.length === 0) return res.sendStatus(403);
    const payload = await jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    console.log("PAYLOAD", payload);
    const { userId, email } = payload;
    const accessToken = generateAccessToken({ userId, email });
    res.json({ accessToken });
  } catch (error) {
    console.log(error);
    res.status(403).send({ error: "Unable to retrieve access token" });
  }
});

router.delete("/signout", async (req, res) => {
  try {
    const refreshToken = req.body.token;
    console.log("DELETE REFRESH TOKEN", refreshToken);
    await pool.query("UPDATE users SET refresh_token=null WHERE refresh_token=$1", [refreshToken]);
    res.sendStatus(204);
  } catch (error) {
    console.log(error.message);
    res.sendStatus(400);
  }
});

router.post("/facebooklogin", (req, res) => {
  const { token } = req.body;
  console.log("ACCESS TOKEN", token);
  let urlGraphFacebook;

  urlGraphFacebook = `https://graph.facebook.com/v10.0/me?fields=email&access_token=${token}`;

  fetch(urlGraphFacebook, {
    method: "GET",
  })
    .then((response) => response.json())
    .then(async (response) => {
      console.log(response);
      const { email } = response;
      console.log("email", email);
      const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
      let user = result.rows[0];

      //if no user then we sign up a new user else we sign in the existing user;
      if (!user) {
        user = await pool.query("INSERT INTO users (email) VALUES($1) RETURNING *", [email]);
        console.log("USER", user);
      }
      const accessToken = generateAccessToken({ userId: user.id, email });
      const refreshToken = generateRefreshToken({ userId: user.id, email });
      res.status(200).send({
        accessToken,
        refreshToken,
        email: user.email,
        income: user.income,
        savings: user.savings,
        createdBudget: user.created_budget,
      });
    })
    .catch((error) => {
      console.log(error);
      return res.status(400).send({ error: "Unable to sign in with facebook, please try again" });
    });
});

router.post("/googlelogin", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    let user = result.rows[0];

    //if no user then we sign up a new user else we sign in the existing user;
    if (!user) {
      user = await pool.query("INSERT INTO users (email) VALUES($1) RETURNING *", [email]);
    }
    console.log("USER", user);
    const accessToken = generateAccessToken({ userId: user.id, email });
    const refreshToken = generateRefreshToken({ userId: user.id, email });
    res.status(200).send({
      accessToken,
      refreshToken,
      email: user.email,
      income: user.income,
      savings: user.savings,
      createdBudget: user.created_budget,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Unable to sign in/sign up, please try again" });
  }
});

router.post("/verificationcode", async (req, res) => {
  try {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000);
    console.log(email, code);
    const data = {
      from: "PiggiBank <piggibankco@gmail.com>",
      to: `${email}`,
      subject: "Reset Your Password",
      text: `Your verification code is : ${code}`,
    };

    mailgun.messages().send(data, (error, body) => {
      if (error) {
        console.log(error);
        return res.status(400).send({ error });
      }
      console.log(body);
      return res.status(200).send({ code });
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error });
  }
});

router.put("/resetpassword", async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (email === null || newPassword === null || isEmpty(email) || isEmpty(newPassword)) {
      return res.status(400).send({ error: "Email, and password are required" });
    }
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }

    let user = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    user = user.rows[0];
    if (!user) {
      return res.status(400).send({ error: "User not found" });
    }
    console.log("USER", user);
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user = await pool.query("UPDATE users SET password=$1 WHERE id=$2 RETURNING *", [hashedPassword, user.id]);
    user = user.rows[0];

    return res.status(200).send({ message: "Success" });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "User not found" });
  }
});

const isEmail = (email) => {
  const regEx =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  if (email.match(regEx)) return true;
  else return false;
};

const isEmpty = (string) => {
  if (string.trim() === "") return true;
  else return false;
};

const generateAccessToken = (user) => {
  return jwt.sign(user, process.env.SECRET_KEY, { expiresIn: "15m" });
};
const generateRefreshToken = (user) => {
  return jwt.sign(user, process.env.REFRESH_TOKEN_SECRET);
};

module.exports = router;

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");

/**
 * AUTHENTICATION ROUTES
 */

//Mailgun js setup
const API_KEY = process.env.MAILGUN_API_KEY;
const DOMAIN = process.env.MAILGUN_DOMAIN;
const mailgun = require("mailgun-js")({ apiKey: API_KEY, domain: DOMAIN });

/**
 * Signs up a user with a given email, password and confirmation password (password2)
 */
router.post("/signup", async (req, res) => {
  try {
    const { email, password, password2 } = req.body;
    console.log(email, password, password2);

    //form data must be valid
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
    //has to be in valid email format
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }
    //passwords must match
    if (password !== password2) {
      return res.status(400).json({ error: "Passwords do not match, please try again" });
    }

    //check to see if user is already signed up
    let isSignedUp = await pool.query("SELECT * FROM users WHERE users.email=$1", [email]);
    isSignedUp = isSignedUp.rows[0];

    if (isSignedUp) {
      return res.status(400).send({ error: "Email is already signed up. Please signin instead" });
    }

    //hash the passwords so we aren't storing the passwords in plain text
    const hashedPassword = await bcrypt.hash(password, 10);
    //add the user to the database
    const result = await pool.query("INSERT INTO users (email, password) VALUES($1, $2) RETURNING *", [
      email,
      hashedPassword,
    ]);
    console.log(result);
    const user = result.rows[0];
    console.log(user);
    //generate an access token to be authenticated for other routes and refresh token to create new access tokens for the user
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

    //add the refresh token to user profile in database so that we can reuse it to gnerate more access tokens
    await pool.query("UPDATE users SET refresh_token = $1 WHERE id=$2", [refreshToken, user.id]);

    res.status(200).send({ accessToken, refreshToken, email: user.email });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: error.message });
  }
});

/**
 * Signs in a user given the email and password and returns an access & refresh token and user information
 */
router.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email, password);

    //must provide an email and password
    if (email === null || password === null || isEmpty(email) || isEmpty(password)) {
      return res.status(400).send({ error: "Must provide email and password" });
    }
    //must provide a valid email
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }

    //checks to see if the user is signed up. if so then compare the password to the one saved in the database.
    //If the same , sign in the user
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

    //generate access & refresh tokens
    const accessToken = generateAccessToken({ userId: user.id, email: user.email });
    const refreshToken = generateRefreshToken({ userId: user.id, email: user.email });

    //add the refresh token to user profile in database
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

/**
 * Route to retrieve a new access given a refresh token
 */
router.post("/token", async (req, res) => {
  try {
    const refreshToken = req.body.token;
    console.log("REFRESH TOKEN", refreshToken);
    if (refreshToken === null) {
      return res.sendStatus(401);
    }
    //Find the refresh token in the database
    let result = await pool.query("SELECT refresh_token FROM users WHERE refresh_token=$1", [refreshToken]);
    result = result.rows;
    console.log("RESULT", result);

    //if refresh token can't be found in database then it must be an invalid refresh token
    if (result.length === 0) return res.sendStatus(403);

    //retrieve user info from the refresh token and use that info to create a new access token
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

/**
 * Route to signout a user by deleting the refresh token from a user's profile in database.
 * This invalidates the deleted refresh token and ensures that the user cannot generate new access tokens anymore from that token
 */
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

/**
 * Route to sign in a user with facebook
 */
router.post("/facebooklogin", (req, res) => {
  const { token } = req.body;
  console.log("FACEBOOK TOKEN", token);
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

      //if no user then we sign up a new user else we sign in the existing user by generating the necessary access and refresh tokens
      if (!user) {
        user = await pool.query("INSERT INTO users (email) VALUES($1) RETURNING *", [email]);
        user = user.rows[0];
        console.log("USER", user);
      }
      const accessToken = generateAccessToken({ userId: user.id, email });
      const refreshToken = generateRefreshToken({ userId: user.id, email });

      await pool.query("UPDATE users SET refresh_token = $1 WHERE id=$2", [refreshToken, user.id]);

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

/**
 * Route to sign in a user with google. Takes in the email that was retrieved from doing the google sign in and signup/signin the user
 */
router.post("/googlelogin", async (req, res) => {
  try {
    const { email } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    let user = result.rows[0];

    //if no user then we sign up a new user with the email else we sign in the existing user;
    if (!user) {
      user = await pool.query("INSERT INTO users (email) VALUES($1) RETURNING *", [email]);
      user = user.rows[0];
    }
    console.log("USER", user);
    const accessToken = generateAccessToken({ userId: user.id, email });
    const refreshToken = generateRefreshToken({ userId: user.id, email });

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
    console.log(error);
    return res.status(400).send({ error: "Unable to sign in/sign up, please try again" });
  }
});

/**
 * Route to send an email with the verification code so that a user can reset their password
 */
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
    //uses mailgun to send emails to the user
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

/**
 * Route to reset password. Takes in the user email and the new password the user wants to change to.
 */
router.put("/resetpassword", async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    if (email === null || newPassword === null || isEmpty(email) || isEmpty(newPassword)) {
      return res.status(400).send({ error: "Email, and password are required" });
    }
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }
    //retrieves the user from database if found then we hash the password and update the user's password
    let user = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    user = user.rows[0];
    if (!user) {
      return res.status(400).send({ error: "User not found" });
    }
    console.log("USER", user);
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    //updates the password of the user in the database
    user = await pool.query("UPDATE users SET password=$1 WHERE id=$2 RETURNING *", [hashedPassword, user.id]);
    user = user.rows[0];

    return res.status(200).send({ message: "Success" });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "User not found" });
  }
});

/**
 *  Checks to see if the provided email is a valid one.
 * @param {*} email
 * @returns a boolean indicating if the email is in valid email format
 */
const isEmail = (email) => {
  const regEx =
    /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  if (email.match(regEx)) return true;
  else return false;
};

/**
 * Checks a given string to see if it is empty without any characters
 * @param {*} string
 * @returns a boolean
 */
const isEmpty = (string) => {
  if (string.trim() === "") return true;
  else return false;
};

/**
 * Creates a signed jwt token to be used as an access token
 * @param {*} user (an object containing userId and user email)
 * @returns a jwt token
 */
const generateAccessToken = (user) => {
  return jwt.sign(user, process.env.SECRET_KEY, { expiresIn: "15m" });
};

/**
 * Creates a signed jwt token to be used as a refresh token
 * @param {*} user
 * @returns  a jwt token
 */
const generateRefreshToken = (user) => {
  return jwt.sign(user, process.env.REFRESH_TOKEN_SECRET);
};

module.exports = router;

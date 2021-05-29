const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const express = require("express");
const router = express.Router();

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
    const accessToken = jwt.sign({ userId: user.id, email: user.email }, process.env.SECRET_KEY);
    res.status(200).send({ token: accessToken, email: user.email });
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
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.SECRET_KEY);
    res.status(200).send({
      token,
      email: user.email,
      income: user.income,
      savings: user.savings,
      createdBudget: user.created_budget,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Invalid email or password" });
  }
});

router.put("/resetpassword", async (req, res) => {
  try {
    const { email, newPassword, confirmPassword } = req.body;
    const user = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
  } catch (error) {}
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

module.exports = router;

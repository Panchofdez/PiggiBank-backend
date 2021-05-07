require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const requireAuth = require("./middleware/requireAuth");

//middleware
app.use(cors());
app.use(express.json());

//ROUTES

//Authentication with email and password
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password, password2 } = req.body;
    console.log(email, password);
    if (isEmpty(email) || isEmpty(password) || isEmpty(password2)) {
      return res
        .status(400)
        .send({ error: "Email, and password are required" });
    }
    if (!isEmail(email)) {
      return res.status(422).json({ error: "Please provide a valid email" });
    }
    if (password !== password2) {
      return res
        .status(400)
        .json({ error: "Passwords do not match, please try again" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password) VALUES($1, $2) RETURNING *",
      [email, hashedPassword]
    );
    console.log(result);
    const user = result.rows[0];
    console.log(user);
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.SECRET_KEY
    );
    res.status(200).send({ token });
  } catch (error) {
    console.log(error);
    return res
      .status(400)
      .send({ error: "Invalid email, email already signed up" });
  }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email, password);
    if (isEmpty(email) || isEmpty(password)) {
      return res.status(400).send({ error: "Must provide email and password" });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE users.email=$1",
      [email]
    );
    const user = result.rows[0];
    console.log(user);
    const isValid = await bcrypt.compare(password, user.password);
    console.log("ISVALID", isValid);
    //passwords don't match
    if (!isValid) {
      res.status(400).send({ error: "Invalid password" });
    }
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.SECRET_KEY
    );
    res.status(200).send({
      token,
      id: user.id,
      email: user.email,
      income: user.income,
      savings: user.savings,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Invalid email or password" });
  }
});

//Set up budget
app.post("/api/createbudget", requireAuth, async (req, res) => {
  try {
    const { income, savings, fixedSpendingList, budgetPeriodType } = req.body;
    console.log(income, savings, fixedSpendingList, budgetPeriodType);
    const id = req.user.id;
    console.log(id);
    const result = await pool.query(
      "UPDATE users SET income=$1, savings=$2, budget_period_type=$3 where id=$4 RETURNING *",
      [income, savings, budgetPeriodType, id]
    );
    const user = result.rows[0];
    console.log(user);

    fixedSpendingList.forEach(async (expense) => {
      console.log(expense);
      await pool.query(
        "INSERT INTO fixed_expenses (title, amount, user_id) VALUES($1, $2, $3)",
        [expense.title, expense.amount, user.id]
      );
    });

    res.status(200).send({
      id: user.id,
      email: user.email,
      income: user.income,
      savings: user.savings,
      budgetPeriodType: user.budget_period_type,
    });
  } catch (error) {
    console.error(error.message);
    return res
      .status(400)
      .send({ error: "Unable to create budget, please try again" });
  }
});

app.listen(5000, () => {
  console.log("Server has started on port 5000");
});

const isEmail = (email) => {
  const regEx = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  if (email.match(regEx)) return true;
  else return false;
};

const isEmpty = (string) => {
  if (string.trim() === "") return true;
  else return false;
};

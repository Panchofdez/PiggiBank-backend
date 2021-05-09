require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const requireAuth = require("./middleware/requireAuth");
const dayjs = require("dayjs");

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
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.SECRET_KEY);
    res.status(200).send({ token });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Invalid email, email already signed up" });
  }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(email, password);
    if (isEmpty(email) || isEmpty(password)) {
      return res.status(400).send({ error: "Must provide email and password" });
    }

    const result = await pool.query("SELECT * FROM users WHERE users.email=$1", [email]);
    const user = result.rows[0];
    console.log(user);
    const isValid = await bcrypt.compare(password, user.password);
    console.log("ISVALID", isValid);
    //passwords don't match
    if (!isValid) {
      res.status(400).send({ error: "Invalid password" });
    }
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.SECRET_KEY);
    res.status(200).send({
      token,
      id: user.id,
      email: user.email,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Invalid email or password" });
  }
});

app.post("/api/budgetperiods", requireAuth, async (req, res) => {
  try {
    let { type } = req.body;
    type = type.toLowerCase();
    const user_id = req.user.id;
    console.log(user_id);
    const today = dayjs().startOf("day");
    console.log(today);

    if (type === "monthly") {
      //we want to add a 12 monthly budget periods (year's worth)
      await addBudgetPeriods(today, type, user_id, 1, "month", 12);
    } else if (type === "weekly") {
      await addBudgetPeriods(today, type, user_id, 1, "week", 52);
    } else if (type === "daily") {
      await addBudgetPeriods(today, type, user_id, 1, "day", 365);
    } else if (type === "biweekly") {
      await addBudgetPeriods(today, type, user_id, 2, "week", 26);
    } else if (type === "yearly") {
      await addBudgetPeriods(today, type, user_id, 1, "year", 3);
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }
    return res.status(200).send({ message: "Successful" });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Unable to create budget periods" });
  }
});

app.get("/api/currentbudgetperiod", requireAuth, async (req, res) => {
  try {
    const today = dayjs("05-09-2022", "MM-DD-YYYY");
    console.log(today);
    const user_id = req.user.id;
    const result = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );
    console.log(result.rows);

    //IF WE CANT FIND A CURRENT BUDGET then add more budget periods using the information from the latest budget period
    if (result.rows.length === 0) {
      let latestBudgetPeriod = await pool.query(
        "SELECT * FROM budget_periods WHERE user_id = $1 AND start_date <= $2 ORDER BY end_date DESC LIMIT 1",
        [user_id, today]
      );

      if (latestBudgetPeriod.rows.length === 1) {
        let { period_type, end_date, income, savings } = latestBudgetPeriod.rows[0];
        //convert the end date to a dayjs date object so we can manipulate it
        end_date = dayjs(end_date);
        if (period_type === "monthly") {
          //we want to add a 12 monthly budget periods (year's worth)
          await addBudgetPeriods(end_date, period_type, user_id, 1, "month", 12, income, savings);
        } else if (period_type === "weekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "week", 52, income, savings);
        } else if (period_type === "daily") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "day", 36, income, savings);
        } else if (period_type === "biweekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 2, "week", 26, income, savings);
        } else if (period_type === "yearly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "year", 3, income, savings);
        }

        //since we created more budget periods we can then retrieve the current one
        const newCurrentBudget = await pool.query(
          "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
          [user_id, today]
        );
        console.log(newCurrentBudget.rows);
        return res.status(200).send({ currentBudgetPeriod: newCurrentBudget.rows[0] });
      }
    }
    const currentBudgetPeriod = result.rows[0];

    if (currentBudgetPeriod.start_date <= today) {
      return res.status(200).send({ currentBudgetPeriod });
    } else {
      return res.json({ error: "No current budget" });
    }
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

//Set up budget
app.post("/api/createbudget", requireAuth, async (req, res) => {
  try {
    const { income, savings, fixedSpendingList, budgetPeriodType } = req.body;
    console.log(income, savings, fixedSpendingList, budgetPeriodType);
    const user_id = req.user.id;
    console.log(user_id);
    const result = await pool.query(
      "UPDATE users SET income=$1, savings=$2, budget_period_type=$3 where id=$4 RETURNING *",
      [income, savings, budgetPeriodType, user_id]
    );
    const user = result.rows[0];
    console.log(user);

    fixedSpendingList.forEach(async (expense) => {
      console.log(expense);
      await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES($1, $2, $3)", [
        expense.title,
        expense.amount,
        user.id,
      ]);
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
    return res.status(400).send({ error: "Unable to create budget, please try again" });
  }
});

//Get all the fixed expenses

app.get("/api/fixedexpenses", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const result = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);
    const fixed_expenses = result.rows;
    return res.status(200).send({ fixed_expenses });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to retrieve fixed expenses, please try again" });
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

const addBudgetPeriods = async (
  initialDate,
  type,
  user_id,
  amount,
  unit,
  numBudgetPeriods,
  income = 0,
  savings = 0
) => {
  try {
    let start_date;
    let end_date;
    for (let i = 0; i < numBudgetPeriods; i++) {
      if (i === 0) {
        start_date = initialDate;
      } else {
        start_date = end_date;
      }
      end_date = start_date.add(amount, unit);
      await pool.query(
        "INSERT INTO budget_periods (period_type, start_date, end_date, user_id, income,  savings) VALUES ($1, $2, $3, $4, $5, $6)",
        [type, start_date, end_date, user_id, income, savings]
      );
    }

    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

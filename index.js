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
    console.log(error.message);
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
    console.log(error.message);
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
      await addBudgetPeriods(today, type, user_id, 1, "month");
    } else if (type === "weekly") {
      await addBudgetPeriods(today, type, user_id, 1, "week");
    } else if (type === "daily") {
      await addBudgetPeriods(today, type, user_id, 1, "day");
    } else if (type === "biweekly") {
      await addBudgetPeriods(today, type, user_id, 2, "week");
    } else if (type === "yearly") {
      await addBudgetPeriods(today, type, user_id, 1, "year");
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }

    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    return res.status(200).send({ currentBudgetPeriod });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to create budget periods" });
  }
});

app.put("/api/budgetperiods", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { startDate, type, currentBudgetPeriodId } = req.body;
    startDate = dayjs(startDate);
    let today = dayjs();
    console.log("START_DATE", startDate);
    //update the current budget_period to end before the startDate of the new budget periods
    await pool.query("UPDATE budget_periods SET end_date=$1 WHERE id = $2", [startDate, currentBudgetPeriodId]);
    await pool.query("DELETE FROM budget_periods WHERE end_date > $1", [startDate]);

    let user = await pool.query("SELECT income, savings FROM users WHERE id=$1", [user_id]);
    user = user.rows[0];

    console.log("USER", user);

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);

    if (type === "monthly") {
      //we want to add a 12 monthly budget periods (year's worth)
      await addBudgetPeriods(startDate, type, user_id, 1, "month", totalBudget);
    } else if (type === "weekly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "week", totalBudget);
    } else if (type === "daily") {
      await addBudgetPeriods(startDate, type, user_id, 1, "day", totalBudget);
    } else if (type === "biweekly") {
      await addBudgetPeriods(startDate, type, user_id, 2, "week", totalBudget);
    } else if (type === "yearly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "year", totalBudget);
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }

    //retrieve the goals to update them according to the budget periods
    let goals = await pool.query("SELECT * FROM goals WHERE user_id = $1", [user_id]);
    goals = goals.rows;
    console.log("GOALS", goals);

    goals.forEach(async (goal) => {
      let progress = await pool.query(
        `SELECT SUM(amount) FROM 
      (
        SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
      ) AS valid_budgets`,
        [goal.id, startDate]
      );
      progress = progress.rows[0].sum;
      console.log("PROGRESS", progress);
      //calculate the average amount to take out every budget period to achieve the goal
      let budgetPeriods = await pool.query(
        "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
        [user_id, goal.end_date, startDate]
      );
      budgetPeriods = budgetPeriods.rows;
      let numBudgetPeriods = budgetPeriods.length;
      console.log("BUDGETPERIODS", budgetPeriods);
      console.log("NUMBUDGETPERIODS", numBudgetPeriods);
      const averageAmount = (goal.amount - progress) / numBudgetPeriods;
      console.log("AVERAGE", averageAmount);

      //then link the user goals with a user's budget periods until the goal is complete
      budgetPeriods.forEach(async (period) => {
        await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
          averageAmount,
          goal.id,
          period.id,
        ]);
      });
    });

    //retrieve the goals linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    return res.status(200).send({ currentBudgetPeriod, currentGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to update budget periods" });
  }
});

app.get("/api/budgetperiods/current", requireAuth, async (req, res) => {
  try {
    const today = dayjs();
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
        let { period_type, end_date } = latestBudgetPeriod.rows[0];
        //convert the end date to a dayjs date object so we can manipulate it
        end_date = dayjs(end_date);
        if (period_type === "monthly") {
          //we want to add a 12 monthly budget periods (year's worth)
          await addBudgetPeriods(end_date, period_type, user_id, 1, "month");
        } else if (period_type === "weekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "week");
        } else if (period_type === "daily") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "day");
        } else if (period_type === "biweekly") {
          await addBudgetPeriods(end_date, period_type, user_id, 2, "week");
        } else if (period_type === "yearly") {
          await addBudgetPeriods(end_date, period_type, user_id, 1, "year");
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
      let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
        currentBudgetPeriod.id,
      ]);

      let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
        user_id,
        currentBudgetPeriod.id,
      ]);
      return res
        .status(200)
        .send({ currentBudgetPeriod, currentGoals: currentGoals.rows, transactions: transactions.rows });
    } else {
      return res.json({ error: "No current budget" });
    }
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

//

// Set up budget
app.post("/api/budget", requireAuth, async (req, res) => {
  try {
    let { income, savings, fixedSpendingList, currentBudgetPeriod } = req.body;
    const user_id = req.user.id;
    const result = await pool.query("UPDATE users SET income=$1, savings=$2 where id=$3 RETURNING *", [
      income,
      savings,
      user_id,
    ]);
    const user = result.rows[0];

    fixedSpendingList.forEach(async (expense) => {
      await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES ($1, $2, $3)", [
        expense.title,
        expense.amount,
        user_id,
      ]);
    });

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);

    const startDate = dayjs(currentBudgetPeriod.start_date);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND start_date >=$3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    //retrieve the updated current budget period again
    currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriod.id]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    res.status(200).send({
      income: user.income,
      savings: user.savings,
      fixedSpendingList,
      fixedSpendingTotal,
      currentBudgetPeriod,
    });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to create budget, please try again" });
  }
});

app.put("/api/budget/income", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { income, startDate, id } = req.body;
    startDate = dayjs(startDate);
    console.log(startDate);
    let user = await pool.query("UPDATE users SET income=$1 WHERE id = $2 RETURNING *", [income, user_id]);
    user = user.rows[0];
    console.log(user);

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [id]);
    return res.status(200).send({
      currentBudgetPeriod: currentBudgetPeriod.rows[0],
      income: user.income,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to set budget income, please try again" });
  }
});

app.put("/api/budget/savings", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { savings, startDate, id } = req.body;
    startDate = dayjs(startDate);
    let user = await pool.query("UPDATE users SET savings=$1 WHERE id=$2 RETURNING *", [savings, user_id]);
    user = user.rows[0];

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);

    //update current and future budget periods
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [id]);
    return res.status(200).send({ currentBudgetPeriod: currentBudgetPeriod.rows[0], savings: user.savings });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to set budget savings, please try again" });
  }
});

//Get all the fixed expenses
app.get("/api/budget/fixedexpenses", requireAuth, async (req, res) => {
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

app.post("/api/budget/fixedexpenses", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { fixedSpendingList, income, savings, startDate, id } = req.body;

    //reset all the users fixed expenses
    await pool.query("DELETE FROM fixed_expenses WHERE user_id=$1", [user_id]);

    fixedSpendingList.forEach(async (expense) => {
      console.log(expense);
      await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES($1, $2, $3)", [
        expense.title,
        expense.amount,
        user_id,
      ]);
    });

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(income, fixedSpendingTotal, savings);
    console.log("TOTAL BUDGET", totalBudget);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [id]);
    return res
      .status(200)
      .send({ currentBudgetPeriod: currentBudgetPeriod.rows[0], fixedSpendingTotal, fixedSpendingList });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to add fixed expenses, please try again" });
  }
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { category, amount, note, date, budget_period_id, transaction_type } = req.body;
    date = dayjs(date);
    await pool.query(
      "INSERT INTO transactions (category, amount, note, date, transaction_type, user_id, budget_period_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [category, amount, note, date, transaction_type, user_id, budget_period_id]
    );

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
      user_id,
      budget_period_id,
    ]);
    transactions = transactions.rows;
    console.log("TRANSACTIONS", transactions);
    return res.status(200).send({ transactions });
  } catch (error) {
    console.log(error.message);
    return res
      .status(400)
      .send({ error: "Unable to add the transaction to the specfied budget period, please try again" });
  }
});

app.delete("/api/transactions", requireAuth, async (req, res) => {
  try {
    const { transaction_id, budget_period_id } = req.body;
    const user_id = req.user.id;
    await pool.query("DELETE FROM transactions WHERE id=$1", [transaction_id]);

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND  budget_period_id=$2", [
      user_id,
      budget_period_id,
    ]);
    transactions = transactions.rows;
    console.log("TRANSACTIONS", transactions);
    return res.status(200).send({ transactions });
  } catch (error) {
    console.log(error.message);
    return res
      .status(400)
      .send({ error: "Unable to delete the transaction from the specfied budget period, please try again" });
  }
});

app.post("/api/goals", requireAuth, async (req, res) => {
  try {
    const { title, amount, duration, numUnits, unitOfTime, colour, icon, currentBudgetPeriodId } = req.body;
    const today = dayjs();
    const endDate = today.add(numUnits, unitOfTime);
    console.log(endDate);
    const user_id = req.user.id;

    //create the goal in goals table
    let goal = await pool.query(
      "INSERT INTO goals (colour, icon, title, amount, duration, end_date, user_id) VALUES ($1,$2,$3,$4,$5,$6, $7) RETURNING *",
      [colour, icon, title, amount, duration, endDate, user_id]
    );
    goal = goal.rows[0];
    console.log("GOAL", goal);

    //calculate the average amount to take out every budget period to achieve the goal
    let budgetPeriods = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;
    let numBudgetPeriods = budgetPeriods.length;
    console.log("BUDGETPERIODS", budgetPeriods);
    console.log("NUMBUDGETPERIODS", numBudgetPeriods);
    const averageAmount = amount / numBudgetPeriods;
    console.log("AVERAGE", averageAmount);

    //then link the user goals with a user's budget periods until the goal is complete
    budgetPeriods.forEach(async (period) => {
      await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
        averageAmount,
        goal.id,
        period.id,
      ]);
    });

    //retrieve the goals linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;
    return res.status(200).send({ currentGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to add goals, please try again" });
  }
});

app.get("/api/goals", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs();
    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    // console.log("GOALS", goals);

    let updatedGoals = await Promise.all(
      goals.map(async (goal) => {
        console.log(goal);
        const progress = await pool.query(
          `SELECT SUM(amount) FROM 
        (
          SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
        ) AS valid_budgets`,
          [goal.id, today]
        );
        console.log(progress.rows[0].sum);
        return Promise.resolve({ ...goal, progress: progress.rows[0].sum });
      })
    );

    console.log(updatedGoals);

    return res.status(200).send({ goals: updatedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve your goals" });
  }
});

app.listen(5000, () => {
  console.log("Server has started on port 5000");
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

const addBudgetPeriods = async (initialDate, type, user_id, amount, unit, total_budget = 0) => {
  try {
    let start_date = initialDate;
    let end_date = start_date.add(amount, unit);
    let final_date = dayjs(initialDate).add(1, "year");

    while (end_date <= final_date) {
      await pool.query(
        "INSERT INTO budget_periods (period_type, start_date, end_date, user_id, total_budget) VALUES ($1, $2, $3, $4, $5)",
        [type, start_date, end_date, user_id, total_budget]
      );
      start_date = end_date;
      end_date = start_date.add(amount, unit);
    }

    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

const getTotalBudget = (income, fixedSpending, savings) => {
  return income - fixedSpending - (income - fixedSpending) * (savings / 100);
};

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
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.SECRET_KEY);
    res.status(200).send({ token, email: user.email });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Invalid email, email already signed up" });
  }
});

app.post("/api/signin", async (req, res) => {
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

app.get("/api/user", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let user = await pool.query("SELECT income, savings, created_budget FROM users WHERE id=$1", [user_id]);
    user = user.rows[0];
    let fixedSpendingList = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);
    fixedSpendingList = fixedSpendingList.rows;
    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;

    return res.status(200).send({ ...user, fixedSpendingList, fixedSpendingTotal });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve user information" });
  }
});

app.post("/api/user/createdbudget", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    //updates a user to have created the initial budget
    let user = await pool.query("UPDATE users SET created_budget=$1 WHERE id=$2 RETURNING *", [true, user_id]);
    user = user.rows[0];
    return res.status(200).send({
      email: user.email,
      income: user.income,
      savings: user.savings,
      createdBudget: user.created_budget,
    });
  } catch (error) {
    console.log(error);
    return res.status(400).send({ error: "Unable to update user information" });
  }
});

app.post("/api/budgetperiods", requireAuth, async (req, res) => {
  try {
    let { type, startDate } = req.body;
    type = type.toLowerCase();
    const user_id = req.user.id;
    console.log(user_id);
    startDate = dayjs(startDate).startOf("day");
    console.log(startDate);

    if (type === "monthly") {
      //we want to add a 12 monthly budget periods (year's worth)
      await addBudgetPeriods(startDate, type, user_id, 1, "month");
    } else if (type === "weekly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "week");
    } else if (type === "daily") {
      await addBudgetPeriods(startDate, type, user_id, 1, "day");
    } else if (type === "biweekly") {
      await addBudgetPeriods(startDate, type, user_id, 2, "week");
    } else if (type === "yearly") {
      await addBudgetPeriods(startDate, type, user_id, 1, "year");
    } else {
      return res.status(400).send({ error: "Invalid budget period type" });
    }

    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, startDate]
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
    type = type.toLowerCase();
    console.log("REQBODY", startDate, type, currentBudgetPeriodId);
    startDate = dayjs(startDate);
    let today = dayjs();
    const unitsOfTime = { daily: "day", monthly: "month", biweekly: "week", weekly: "week", yearly: "year" };
    const numUnits = { daily: 1, monthly: 1, biweekly: 2, weekly: 1, yearly: 1 };

    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    console.log(currentBudgetPeriod);
    //update the current budget_period
    //if the start date of the new budget periods is equal or after the start of the current budget period then set the end date of the current period to the start date
    //if before then update the current budget period to start at the startdate
    if (startDate <= currentBudgetPeriod.start_date) {
      let endDate = startDate.add(numUnits[type], unitsOfTime[type]);
      currentBudgetPeriod = await pool.query(
        "UPDATE budget_periods SET start_date = $1, end_date=$2, period_type=$3 WHERE id = $4 RETURNING *",
        [startDate, endDate, type, currentBudgetPeriodId]
      );
      startDate = endDate;
    } else {
      currentBudgetPeriod = await pool.query("UPDATE budget_periods SET end_date=$1 WHERE id = $2 RETURNING *", [
        startDate,
        currentBudgetPeriodId,
      ]);
    }
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    console.log("START_DATE", startDate);
    //delete the following budget periods so we can make new updated ones
    await pool.query("DELETE FROM budget_periods WHERE end_date > $1 AND user_id=$2", [startDate, user_id]);

    //Recalculate the total budget
    let user = await pool.query("SELECT income, savings FROM users WHERE id=$1", [user_id]);
    user = user.rows[0];
    console.log("USER", user);
    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
    const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
    console.log("TOTAL BUDGET", totalBudget);

    //then add the rest of the budget_periods
    if (type in unitsOfTime) {
      console.log(numUnits[type], unitsOfTime[type]);
      await addBudgetPeriods(startDate, type, user_id, numUnits[type], unitsOfTime[type], totalBudget);
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

    //retrieve the goals and transactions linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
      user_id,
      currentBudgetPeriod.id,
    ]);

    transactions = transactions.rows;

    return res.status(200).send({ currentBudgetPeriod, currentGoals, transactions });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to update budget periods" });
  }
});

app.get("/api/budgetperiods/current", requireAuth, async (req, res) => {
  try {
    const today = dayjs();

    const user_id = req.user.id;
    const result = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );

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
        return res.status(200).send({
          currentBudgetPeriod: newCurrentBudget.rows[0],
          currentGoals: [],
          transactions: [],
        });
      }
    }
    const currentBudgetPeriod = result.rows[0];

    if (currentBudgetPeriod) {
      let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
        currentBudgetPeriod.id,
      ]);

      let transactions = await pool.query("SELECT * FROM transactions WHERE user_id = $1 AND budget_period_id=$2", [
        user_id,
        currentBudgetPeriod.id,
      ]);

      return res.status(200).send({
        currentBudgetPeriod,
        currentGoals: currentGoals.rows,
        transactions: transactions.rows,
      });
    } else {
      return res.status(400).send({ error: "No current budget" });
    }
  } catch (error) {
    return res.status(400).send({ error: error.message });
  }
});

app.post("/api/budget/income", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { income, startDate, currentBudgetPeriodId } = req.body;
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

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
    return res.status(200).send({
      currentBudgetPeriod: currentBudgetPeriod.rows[0],
      income: user.income,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to set budget income, please try again" });
  }
});

app.post("/api/budget/savings", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { savings, startDate, currentBudgetPeriodId } = req.body;
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

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);
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
    const { fixedSpendingList, startDate, currentBudgetPeriodId } = req.body;

    console.log(fixedSpendingList);

    //reset all the users fixed expenses
    await pool.query("DELETE FROM fixed_expenses WHERE user_id=$1", [user_id]);

    for (let i = 0; i < fixedSpendingList.length; i++) {
      let expense = fixedSpendingList[i];
      await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES($1, $2, $3)", [
        expense.title,
        expense.amount,
        user_id,
      ]);
    }

    //retrieve the user
    let user = await pool.query("SELECT income, savings FROM users WHERE id = $1", [user_id]);
    const { income, savings } = user.rows[0];

    let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
    fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;

    console.log("fixedSpendingTotal", fixedSpendingTotal);
    //we have to recalculate the total budget
    const totalBudget = getTotalBudget(income, fixedSpendingTotal, savings);
    console.log("TOTAL BUDGET", totalBudget);
    await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND end_date > $3", [
      totalBudget,
      user_id,
      startDate,
    ]);

    const currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriodId]);

    let newFixedSpendingList = await pool.query("SELECT * FROM fixed_expenses WHERE user_id=$1", [user_id]);

    return res.status(200).send({
      currentBudgetPeriod: currentBudgetPeriod.rows[0],
      fixedSpendingTotal,
      fixedSpendingList: newFixedSpendingList.rows,
    });
  } catch (error) {
    console.error(error.message);
    return res.status(400).send({ error: "Unable to add fixed expenses, please try again" });
  }
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    let { category, amount, note, date, budget_period_id, transaction_type, icon, colour } = req.body;
    date = dayjs(date);
    await pool.query(
      "INSERT INTO transactions (category, amount, note, date, transaction_type, user_id, budget_period_id, icon, colour) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [category, amount, note, date, transaction_type, user_id, budget_period_id, icon, colour]
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

app.get("/api/transactions/habits/:budgetPeriodId", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const budgetPeriodId = req.params.budgetPeriodId;
    console.log(user_id, budgetPeriodId);
    let expenseHabits = await pool.query(
      "SELECT category, SUM(amount) FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND transaction_type=$3 GROUP BY category",
      [user_id, budgetPeriodId, "expense"]
    );
    expenseHabits = expenseHabits.rows;

    //We have to retrieve the icon and colour for each expense category
    for (let i = 0; i < expenseHabits.length; i++) {
      let item = expenseHabits[i];
      let result = await pool.query(
        "SELECT icon, colour FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND category=$3",
        [user_id, budgetPeriodId, item.category]
      );
      const { icon, colour } = result.rows[0];
      expenseHabits[i] = { ...item, icon, colour };
    }

    let earningHabits = await pool.query(
      "SELECT category, SUM(amount) FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND transaction_type=$3 GROUP BY category",
      [user_id, budgetPeriodId, "earning"]
    );
    earningHabits = earningHabits.rows;

    //We have to retrieve the icon and colour for each earning category
    for (let i = 0; i < earningHabits.length; i++) {
      let item = earningHabits[i];
      let result = await pool.query(
        "SELECT icon, colour FROM transactions WHERE user_id=$1 AND budget_period_id=$2 AND category=$3",
        [user_id, budgetPeriodId, item.category]
      );
      const { icon, colour } = result.rows[0];
      earningHabits[i] = { ...item, icon, colour };
    }

    //get the period start_date so we can search for the next and previous budget periods
    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [budgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const { start_date, end_date } = currentBudgetPeriod;

    let nextBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, end_date]
    );
    nextBudgetPeriodId = nextBudgetPeriodId.rows[0] ? nextBudgetPeriodId.rows[0].id : null;

    let previousBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date < $2 ORDER BY end_date DESC LIMIT 1",
      [user_id, end_date]
    );
    previousBudgetPeriodId = previousBudgetPeriodId.rows[0] ? previousBudgetPeriodId.rows[0].id : null;

    let transactions = await pool.query("SELECT * FROM transactions WHERE user_id=$1 AND budget_period_id=$2", [
      user_id,
      currentBudgetPeriod.id,
    ]);

    transactions = transactions.rows;
    return res.status(200).send({
      earningHabits,
      expenseHabits,
      currentBudgetPeriod,
      previousBudgetPeriodId,
      nextBudgetPeriodId,
      transactions,
    });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve transaction habits, please try again" });
  }
});

app.get("/api/transactions/habits", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { category, budgetPeriodId } = req.query;
    console.log(category, budgetPeriodId);
    let transactions = await pool.query(
      "SELECT * FROM transactions WHERE user_id =$1 AND category = $2 AND budget_period_id =$3",
      [user_id, category, budgetPeriodId]
    );
    transactions = transactions.rows;

    let currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [budgetPeriodId]);
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const { start_date, end_date } = currentBudgetPeriod;

    let nextBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, end_date]
    );
    nextBudgetPeriodId = nextBudgetPeriodId.rows[0] ? nextBudgetPeriodId.rows[0].id : null;

    let previousBudgetPeriodId = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 ORDER BY end_date DESC LIMIT 1",
      [user_id, end_date]
    );
    previousBudgetPeriodId = previousBudgetPeriodId.rows[0] ? previousBudgetPeriodId.rows[0].id : null;

    let previousAmountSpent = await pool.query(
      "SELECT SUM(amount) FROM transactions WHERE user_id =$1 AND budget_period_id=$2 AND category=$3",
      [user_id, previousBudgetPeriodId, category]
    );
    console.log(previousAmountSpent.rows[0]);
    previousAmountSpent = previousAmountSpent.rows[0].sum !== null ? previousAmountSpent.rows[0].sum : 0;

    let currentAmountSpent = await pool.query(
      "SELECT SUM(amount) FROM transactions WHERE user_id =$1 AND budget_period_id=$2 AND category=$3",
      [user_id, budgetPeriodId, category]
    );
    console.log(currentAmountSpent.rows[0]);
    currentAmountSpent = currentAmountSpent.rows[0].sum !== null ? currentAmountSpent.rows[0].sum : 0;
    let monthlyDifference;
    if (previousAmountSpent === 0) {
      monthlyDifference = "N/A";
    } else {
      monthlyDifference = ((currentAmountSpent - previousAmountSpent) / Math.abs(previousAmountSpent)) * 100;
    }
    console.log(previousAmountSpent, currentAmountSpent, monthlyDifference);
    return res
      .status(200)
      .send({ transactions, currentBudgetPeriod, previousBudgetPeriodId, nextBudgetPeriodId, monthlyDifference });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve transactions for this category, please try again" });
  }
});

app.get("/api/goals/averageamount", requireAuth, async (req, res) => {
  try {
    const { amount, numUnits, unitOfTime } = req.query;
    const user_id = req.user.id;
    console.log(amount, numUnits, unitOfTime);
    const today = dayjs();
    const endDate = today.add(numUnits, unitOfTime);

    console.log("ENDDATE", endDate);
    //calculate the average amount to take out every budget period to achieve the goal
    let budgetPeriods = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;
    let numBudgetPeriods = budgetPeriods.length;
    console.log("BUDGETPERIODS", budgetPeriods);
    console.log("NUMBUDGETPERIODS", numBudgetPeriods);
    let averageAmount;
    if (numBudgetPeriods === 0) {
      averageAmount = amount;
    } else {
      averageAmount = amount / numBudgetPeriods;
    }
    console.log("AVERAGE", averageAmount);
    return res.status(200).send({ averageAmount, endDate });
  } catch (error) {
    console.log(error.message);
    res
      .status(400)
      .send({ error: "Unable to calculate average amount to take from budget period to achieve the goal" });
  }
});

app.post("/api/goals", requireAuth, async (req, res) => {
  try {
    const { title, amount, duration, averageAmount, endDate, colour, icon, currentBudgetPeriodId } = req.body;
    const today = dayjs();
    // const endDate = today.add(numUnits, unitOfTime);
    // console.log(endDate);
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
    // let numBudgetPeriods = budgetPeriods.length;
    // console.log("BUDGETPERIODS", budgetPeriods);
    // console.log("NUMBUDGETPERIODS", numBudgetPeriods);
    // const averageAmount = amount / numBudgetPeriods;
    // console.log("AVERAGE", averageAmount);

    //then link the user goals with a user's budget periods until the goal is complete
    if (budgetPeriods.length === 0) {
      await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
        averageAmount,
        goal.id,
        currentBudgetPeriodId,
      ]);
    } else {
      for (let i = 0; i < budgetPeriods.length; i++) {
        let period = budgetPeriods[i];
        await pool.query("INSERT INTO budget_period_goals (amount, goal_id,budget_period_id ) VALUES ($1, $2, $3)", [
          averageAmount,
          goal.id,
          period.id,
        ]);
      }
    }

    //retrieve the goals linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

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

    return res.status(200).send({ currentGoals, goals: updatedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to add goals, please try again" });
  }
});

app.get("/api/goals/:currentBudgetPeriodId", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { currentBudgetPeriodId } = req.params;
    const today = dayjs();
    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    console.log("GOALS", goals);
    //We only want the relevant goals that are part of the current budget period
    let currentGoals = await pool.query("SELECT goal_id FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    goals = goals.filter((goal) => {
      for (let i = 0; i < currentGoals.length; i++) {
        if (currentGoals[i].goal_id === goal.id) {
          return true;
        }
      }
      return false;
    });

    console.log("AFTER", goals);

    let updatedGoals = await Promise.all(
      goals.map(async (goal) => {
        const progress = await pool.query(
          `SELECT SUM(amount) FROM 
        (
          SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
        ) AS valid_budgets`,
          [goal.id, today]
        );
        return Promise.resolve({ ...goal, progress: progress.rows[0].sum });
      })
    );

    console.log("UPDATED", updatedGoals);

    return res.status(200).send({ goals: updatedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve your goals" });
  }
});

app.get("/api/achievements", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs();
    let amountSaved = await pool.query(
      `SELECT SUM(savings) FROM
    ( 
    SELECT * FROM budget_periods JOIN users ON budget_periods.user_id = users.id WHERE user_id = $1 AND end_date <= $2
    ) AS  past_budgets`,
      [user_id, today]
    );
    //the amount of money saved by the user
    console.log(amountSaved.rows);
    amountSaved = parseInt(amountSaved.rows[0].sum);

    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    let completedGoals = 0;
    for (let i = 0; i < goals.length; i++) {
      let progress = await pool.query(
        `SELECT SUM(amount) FROM 
        (
          SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
        ) AS valid_budgets`,
        [goals[i].id, today]
      );
      progress = progress.rows[0].sum;
      if (progress >= goals[i].amount) {
        console.log(progress, goals[i].amount);
        completedGoals++;
      }
    }

    //To calculate the number of budget periods that a user has completed
    let numBudgetPeriods = await pool.query("SELECT COUNT(*) FROM budget_periods WHERE user_id=$1 AND end_date <= $2", [
      user_id,
      today,
    ]);
    numBudgetPeriods = parseInt(numBudgetPeriods.rows[0].count);

    //We need to calculate if the user ha been budgeting for at least a year
    let initialStartDate = await pool.query(
      "SELECT start_date FROM budget_periods WHERE user_id=$1 ORDER BY start_date ASC LIMIT 1",
      [user_id]
    );
    initialStartDate = initialStartDate.rows[0].start_date;

    let fullYear = dayjs(initialStartDate).add(1, "year");

    console.log(initialStartDate, fullYear);
    console.log(dayjs("May 23 2022") >= fullYear);

    console.log(amountSaved, completedGoals, numBudgetPeriods);
    let achievements = [
      {
        title: "Save $100",
        completed: amountSaved >= 10,
      },
      {
        title: "Save $1000",
        completed: amountSaved >= 1000,
      },
      {
        title: "Save $5000",
        completed: amountSaved >= 5000,
      },
      {
        title: "Complete 1 Goal",
        completed: completedGoals >= 1,
      },
      {
        title: "Complete 5 Goals",
        completed: completedGoals >= 5,
      },
      {
        title: "Complete 10 Goals",
        completed: completedGoals >= 10,
      },
      {
        title: "Budget For 3 Periods",
        completed: numBudgetPeriods >= 3,
      },
      {
        title: "Budget For A Full Year",
        completed: today >= fullYear,
      },
      {
        title: "Save $10,000",
        completed: amountSaved >= 10000,
      },
    ];
    console.log(achievements);
    return res.status(200).send({ achievements });
  } catch (error) {
    console.log(error.message);
    return res.status(400);
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
// // Set up budget
// app.post("/api/budget", requireAuth, async (req, res) => {
//   try {
//     let { income, savings, fixedSpendingList, currentBudgetPeriod } = req.body;
//     const user_id = req.user.id;
//     const result = await pool.query("UPDATE users SET income=$1, savings=$2 where id=$3 RETURNING *", [
//       income,
//       savings,
//       user_id,
//     ]);
//     const user = result.rows[0];

//     fixedSpendingList.forEach(async (expense) => {
//       await pool.query("INSERT INTO fixed_expenses (title, amount, user_id) VALUES ($1, $2, $3)", [
//         expense.title,
//         expense.amount,
//         user_id,
//       ]);
//     });

//     let fixedSpendingTotal = await pool.query("SELECT SUM(amount) FROM fixed_expenses WHERE user_id = $1", [user_id]);
//     fixedSpendingTotal = fixedSpendingTotal.rows[0].sum;
//     const totalBudget = getTotalBudget(user.income, fixedSpendingTotal, user.savings);
//     console.log("TOTAL BUDGET", totalBudget);

//     const startDate = dayjs(currentBudgetPeriod.start_date);
//     await pool.query("UPDATE budget_periods SET total_budget=$1 WHERE user_id=$2 AND start_date >=$3", [
//       totalBudget,
//       user_id,
//       startDate,
//     ]);

//     //retrieve the updated current budget period again
//     currentBudgetPeriod = await pool.query("SELECT * FROM budget_periods WHERE id=$1", [currentBudgetPeriod.id]);
//     currentBudgetPeriod = currentBudgetPeriod.rows[0];
//     res.status(200).send({
//       income: user.income,
//       savings: user.savings,
//       fixedSpendingList,
//       fixedSpendingTotal,
//       currentBudgetPeriod,
//     });
//   } catch (error) {
//     console.error(error.message);
//     return res.status(400).send({ error: "Unable to create budget, please try again" });
//   }
// });

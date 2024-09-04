const pool = require("../db");
const dayjs = require("dayjs");
const requireAuth = require("../middleware/requireAuth");
const express = require("express");
const router = express.Router();

const UNIT_OF_TIME = { daily: "day", monthly: "month", biweekly: "week", weekly: "week", yearly: "year" };
const NUM_UNITS = { daily: 1, monthly: 1, biweekly: 2, weekly: 1, yearly: 1 };
/**
 * Retrieves the average amount to take out of each budget period to achieve the goal.
 * It takes in the goal amount which is the money it takes to reach the goal,
 * and it takes the numUnits and unitOfTime which is used to calculate how long we have to achieve the goal
 */
router.get("/averageamount", requireAuth, async (req, res) => {
  try {
    const { amount, numUnits, unitOfTime, goalId } = req.query;
    const user_id = req.user.id;
    const today = dayjs();
    const endDate = today.add(numUnits, unitOfTime).startOf("day");

    //calculate the average amount to take out every budget period to achieve the goal
    let budgetPeriods = await pool.query(
      "SELECT id, period_type, end_date FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3 ORDER BY end_date ASC",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;
    let numBudgetPeriods = budgetPeriods.length;

    let averageAmount;
    if (goalId){
      // if the goal already exists then pull the average amount from the latest budget period goal
      let latestBudgetPeriodGoal = await pool.query(
        "SELECT * FROM budget_period_goals WHERE goal_id = $1 ORDER BY id DESC LIMIT 1",
        [goalId]
      )
      latestBudgetPeriodGoal = latestBudgetPeriodGoal.rows[0];
      if (latestBudgetPeriodGoal){
        averageAmount = latestBudgetPeriodGoal.amount
      }
    }

    //handles the case for when the user wants to achieve a goal at a date that is farther than the last budget period in the database.
    //For ex. a user wants to achieve a goal in 3 years but we only have a year's worth in budget periods. This results in the miscalculation of the amount to take out
    //we need to extend the number of budget periods to account for the entire duration expected to achieve the goal
    if (!averageAmount){
      if (numBudgetPeriods === 0) {
        averageAmount = amount;
      } else {
        let periodEndDate = dayjs(budgetPeriods[budgetPeriods.length - 1].end_date);
        let periodType = budgetPeriods[budgetPeriods.length - 1].period_type;

        while (periodEndDate < endDate) {
          periodEndDate = periodEndDate.add(NUM_UNITS[periodType], UNIT_OF_TIME[periodType]);
          if (periodEndDate >= endDate) {
            break;
          } else {
            numBudgetPeriods++;
          }
        }
        averageAmount = amount / numBudgetPeriods;
      }
    }
    return res.status(200).send({ averageAmount, endDate });
  } catch (error) {
    console.log(error.message);
    res
      .status(400)
      .send({ error: "Unable to calculate average amount to take from budget period to achieve the goal" });
  }
});

/**
 * Creates a user goal and updates the necessary budget periods to take out the amount needed to achieve the goal.
 *
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { title, amount, duration, averageAmount, endDate, colour, icon, currentBudgetPeriodId } = req.body;
    const today = dayjs();
    // const endDate = today.add(numUnits, unitOfTime);
    const user_id = req.user.id;

    //create the goal in goals table
    let goal = await pool.query(
      "INSERT INTO goals (colour, icon, title, amount, duration, end_date, user_id) VALUES ($1,$2,$3,$4,$5,$6, $7) RETURNING *",
      [colour, icon, title, amount, duration, endDate, user_id]
    );
    goal = goal.rows[0];

    //retrieve the remaining number of budget periods
    let budgetPeriods = await pool.query(
      "SELECT id FROM budget_periods WHERE user_id=$1 AND end_date <= $2 AND end_date > $3",
      [user_id, endDate, today]
    );
    budgetPeriods = budgetPeriods.rows;

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

    //Calculates the progress of each goal and adds it to the goal object
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
    //Get all the goals that have been completed recently so we can show a modal celebrating the completion of their goals
    const recentlyCompletedGoals = [];
    for (let i = 0; i < updatedGoals.length; i++) {
      let goal = updatedGoals[i];
      const amountLeft = parseFloat(goal.amount) - parseFloat(goal.progress);
      if (amountLeft < 1 && goal.completed === false) {
        recentlyCompletedGoals.push(goal);
        await pool.query("UPDATE goals SET completed=true WHERE id=$1", [goal.id]);
        updatedGoals[i].completed = true;
        updatedGoals[i].progress = goal.amount;
      }
    }

    return res.status(200).send({ currentGoals, goals: updatedGoals, recentlyCompletedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to add goals, please try again" });
  }
});

/**
 * Delete a user's goal
 */
router.delete("/:goalId", requireAuth, async (req, res) => {
  try {
    const goalId= req.params.goalId;
    const user_id = req.user.id;
    const today = dayjs();
    //Retrieves the most current budget period
    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );
    
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const currentBudgetPeriodId = currentBudgetPeriod.id;
   
    await pool.query("DELETE FROM goals WHERE id=$1", [goalId]);

    //retrieve the goals linked to the current budget period
    let currentGoals = await pool.query("SELECT * FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;

    //Calculates the progress of each goal and adds it to the goal object
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
    //Get all the goals that have been completed recently so we can show a modal celebrating the completion of their goals
    const recentlyCompletedGoals = [];
    for (let i = 0; i < updatedGoals.length; i++) {
      let goal = updatedGoals[i];
      const amountLeft = parseFloat(goal.amount) - parseFloat(goal.progress);
      if (amountLeft < 1 && goal.completed === false) {
        recentlyCompletedGoals.push(goal);
        await pool.query("UPDATE goals SET completed=true WHERE id=$1", [goal.id]);
        updatedGoals[i].completed = true;
        updatedGoals[i].progress = goal.amount;
      }
    }

    return res.status(200).send({ currentGoals, goals: updatedGoals, recentlyCompletedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable delete goal, please try again" });
  }
});

/**
 * Gets the achievements of the user
 */
router.get("/achievements", requireAuth, async (req, res) => {
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

      if (parseFloat(progress) >= parseFloat(goals[i].amount)) {
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

    //array containing the user achievements
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

    const recentlyCompletedAchievements = [];
    for (let i = 0; i < achievements.length; i++) {
      if (achievements[i].completed === true) {
        let result = await pool.query("SELECT * FROM achievements WHERE user_id=$1 AND title=$2", [
          user_id,
          achievements[i].title,
        ]);
        if (!result.rows[0]) {
          recentlyCompletedAchievements.push(achievements[i]);
          await pool.query("INSERT INTO achievements (title, user_id) VALUES ($1, $2)", [
            achievements[i].title,
            user_id,
          ]);
        }
      }
    }
    return res.status(200).send({ achievements, recentlyCompletedAchievements });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve achievements" });
  }
});

/**
 * Get the goals that are affecting the current budget period
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const user_id = req.user.id;
    const today = dayjs();
    //Retrieves the most current budget period
    let currentBudgetPeriod = await pool.query(
      "SELECT * FROM budget_periods WHERE user_id = $1 AND end_date > $2 ORDER BY end_date ASC LIMIT 1",
      [user_id, today]
    );
    currentBudgetPeriod = currentBudgetPeriod.rows[0];
    const currentBudgetPeriodId = currentBudgetPeriod.id;

    //get all the user goals
    let goals = await pool.query("SELECT * FROM goals WHERE user_id=$1", [user_id]);
    goals = goals.rows;
    //We only want the relevant goals that are part of the current budget period
    let currentGoals = await pool.query("SELECT goal_id FROM budget_period_goals WHERE budget_period_id=$1", [
      currentBudgetPeriodId,
    ]);
    currentGoals = currentGoals.rows;

    //only get the goals that are taking money from the budget of the current budget period
    goals = goals.filter((goal) => {
      for (let i = 0; i < currentGoals.length; i++) {
        if (currentGoals[i].goal_id === goal.id) {
          return true;
        }
      }
      return false;
    });

    //calculate the progress of each goal
    let updatedGoals = await Promise.all(
      goals.map(async (goal) => {
        let progress = await pool.query(
          `SELECT SUM(amount) FROM 
          (
            SELECT amount, start_date, end_date FROM budget_period_goals JOIN budget_periods ON budget_period_goals.budget_period_id = budget_periods.id WHERE goal_id = $1 AND start_date <= $2
          ) AS valid_budgets`,
          [goal.id, today]
        );

        progress = progress.rows[0].sum;
        return Promise.resolve({ ...goal, progress });
      })
    );

    //Get all the goals that have been completed recently so we can show a modal celebrating the completion of their goals
    const recentlyCompletedGoals = [];
    for (let i = 0; i < updatedGoals.length; i++) {
      let goal = updatedGoals[i];
      const amountLeft = parseFloat(goal.amount) - parseFloat(goal.progress);
      if (amountLeft < 1 && goal.completed === false) {
        recentlyCompletedGoals.push(goal);
        await pool.query("UPDATE goals SET completed=true WHERE id=$1", [goal.id]);
        updatedGoals[i].completed = true;
        updatedGoals[i].progress = goal.amount;
      }
    }

    return res.status(200).send({ goals: updatedGoals, recentlyCompletedGoals });
  } catch (error) {
    console.log(error.message);
    return res.status(400).send({ error: "Unable to retrieve your goals" });
  }
});

module.exports = router;

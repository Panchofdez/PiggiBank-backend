require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const authRoutes = require("./routes/authRoutes");
const budgetPeriodsRoutes = require("./routes/budgetPeriodsRoutes");
const budgetRoutes = require("./routes/budgetRoutes");
const goalsRoutes = require("./routes/goalsRoutes");
const transactionsRoutes = require("./routes/transactionsRoutes");
const userRoutes = require("./routes/userRoutes");

//MIDDLEWARE
app.use(cors());
app.use(express.json());

//ROUTES
app.use("/api", authRoutes);
app.use("/api/budgetperiods", budgetPeriodsRoutes);
app.use("/api/budget", budgetRoutes);
app.use("/api/goals", goalsRoutes);
app.use("/api/transactions", transactionsRoutes);
app.use("/api/user", userRoutes);

app.get("*", (req, res) => {
  res.send({ message: "Hello welcome to PiggiBank API" });
});
app.listen(process.env.PORT || 5000, () => {
  console.log("Server has started on port 5000");
});

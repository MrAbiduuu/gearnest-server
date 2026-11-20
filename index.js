import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
const port = process.env.PORT;

app.use(express.json());
app.use(cors());
import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db("gearnestdb");
const users = database.collection("user");
const equipments = database.collection("equipments");

app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});
app.get("/equipments", async (req, res) => {
  const cursor = equipments.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/", (req, res) => {
  res.send({ message: "Hello World!" });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

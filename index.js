import express from "express";
import cors from "cors";
import "dotenv/config";
import { ObjectId } from "mongodb";

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

// Equipment related apis
// getting all equipments
app.get("/equipments", async (req, res) => {
  try {
    const result = await equipments.find({}).toArray();

    res.status(200).send({
      success: true,
      message: "Equipments retrieved successfully",
      data: result,
    });
  } catch (error) {
    res.status(500).send({
      success: false,
      message: "Failed to retrieve equipments",
      error,
    });
  }
});

// getting single equipments
app.get("/equipments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const query = { _id: new ObjectId(id) };

    const result = await equipments.findOne(query);

    if (!result) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      success: false,
      message: "Something went wrong",
    });
  }
});

app.get("/", (req, res) => {
  res.send({ message: "Hello World!" });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

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

// creating a new equipment listing
app.post("/equipments", async (req, res) => {
  try {
    const {
      name,
      category,
      description,
      rentalRate,
      rentalPeriod,
      availableStock,
      brand,
      model,
      condition,
      location,
      rentalTerms,
      imageUrls,
      owner,
    } = req.body ?? {};

    const requiredFields = {
      name,
      category,
      description,
      rentalRate,
      rentalPeriod,
      availableStock,
      location,
    };

    const missingFields = Object.entries(requiredFields)
      .filter(([, value]) => value === undefined || value === null || value === "")
      .map(([field]) => field);

    if (missingFields.length > 0) {
      return res.status(400).send({
        success: false,
        message: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const parsedRentalRate = Number(rentalRate);
    const parsedStock = Number(availableStock);

    if (
      !Number.isFinite(parsedRentalRate) ||
      parsedRentalRate <= 0 ||
      !Number.isInteger(parsedStock) ||
      parsedStock < 1
    ) {
      return res.status(400).send({
        success: false,
        message: "Rental rate and available stock must be valid positive numbers.",
      });
    }

    const urls = Array.isArray(imageUrls)
      ? imageUrls.filter((url) => typeof url === "string" && url.trim() !== "")
      : [];

    const document = {
      name: String(name).trim(),
      shortDescription: String(description).trim().slice(0, 160),
      description: String(description).trim(),
      category: String(category).trim(),
      image: urls[0] ?? "",
      images: urls,
      brand: String(brand ?? "").trim(),
      model: String(model ?? "").trim(),
      condition: String(condition ?? "Good").trim(),
      availableStock: parsedStock,
      rentalRate: parsedRentalRate,
      rentalPeriod: String(rentalPeriod).trim(),
      location: String(location).trim(),
      rentalTerms: String(rentalTerms ?? "").trim(),
      status: "pending",
      owner: {
        name: String(owner?.name ?? "").trim(),
        email: String(owner?.email ?? "").trim(),
        isVerified: owner?.isVerified ?? true,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await equipments.insertOne(document);

    res.status(201).send({
      success: true,
      message: "Equipment published successfully",
      data: { ...document, _id: result.insertedId.toString() },
    });
  } catch (error) {
    console.error(error);

    res.status(500).send({
      success: false,
      message: "Failed to publish equipment",
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

// updating an equipment listing
app.patch("/equipments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const query = { _id: new ObjectId(id) };
    const existing = await equipments.findOne(query);

    if (!existing) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    const body = req.body ?? {};
    const pick = (key, fallback = "") =>
      body[key] !== undefined ? body[key] : existing[key] ?? fallback;

    const urls =
      body.imageUrls !== undefined
        ? Array.isArray(body.imageUrls)
          ? body.imageUrls.filter((url) => typeof url === "string" && url.trim() !== "")
          : []
        : Array.isArray(existing.images)
          ? existing.images
          : existing.image
            ? [existing.image]
            : [];

    const name = String(pick("name")).trim();
    const category = String(pick("category")).trim();
    const description = String(pick("description")).trim();
    const rentalRate = Number(pick("rentalRate"));
    const rentalPeriod = String(pick("rentalPeriod")).trim();
    const availableStock = Number(pick("availableStock"));
    const location = String(pick("location")).trim();

    if (!name || !category || !description || !rentalPeriod || !location) {
      return res.status(400).send({
        success: false,
        message: "Please complete all required fields.",
      });
    }

    if (
      !Number.isFinite(rentalRate) ||
      rentalRate <= 0 ||
      !Number.isInteger(availableStock) ||
      availableStock < 1
    ) {
      return res.status(400).send({
        success: false,
        message: "Rental rate and available stock must be valid positive numbers.",
      });
    }

    const update = {
      name,
      shortDescription: description.slice(0, 160),
      description,
      category,
      image: urls[0] ?? "",
      images: urls,
      brand: String(pick("brand")).trim(),
      model: String(pick("model")).trim(),
      condition: String(pick("condition", "Good")).trim(),
      availableStock,
      rentalRate,
      rentalPeriod,
      location,
      rentalTerms: String(pick("rentalTerms")).trim(),
      status: existing.status ?? "pending",
      owner: existing.owner ?? {
        name: String(body.owner?.name ?? "").trim(),
        email: String(body.owner?.email ?? "").trim(),
        isVerified: body.owner?.isVerified ?? true,
      },
      updatedAt: new Date(),
    };

    await equipments.updateOne(query, { $set: update });
    const updated = await equipments.findOne(query);

    res.status(200).send({
      success: true,
      message: "Equipment updated successfully",
      data: { ...updated, _id: id },
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to update equipment",
    });
  }
});

// deleting an equipment listing
app.delete("/equipments/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid equipment ID",
      });
    }

    const result = await equipments.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Equipment not found",
      });
    }

    res.status(200).send({
      success: true,
      message: "Equipment deleted successfully",
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({
      success: false,
      message: "Failed to delete equipment",
    });
  }
});

app.get("/", (req, res) => {
  res.send({ message: "Hello World!" });
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

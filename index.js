const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
// config
dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pw0rah1.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db("parcelDB");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    // const trackingCollection = db.collection("tracking");
    // custom middlewares
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      // verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    // Create new parcel
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelsCollection.insertOne(newParcel);
      res.send(result);
    });

    // Get all parcels
    // GET: All parcels OR parcels by user (created_by), sorted by latest
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;

        const query = userEmail ? { createdBy: userEmail } : {};
        const options = {
          sort: { creation_time: -1 },
        };

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // GET: Get a specific parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).send({ message: "Failed to fetch parcel" });
      }
    });

    // Get tracking logs by tracking ID
    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId;
        const logs = await parcelsCollection.findOne({
          trackingId: trackingId,
        });

        res.send(logs);
      } catch (error) {
        console.error("Failed to fetch tracking logs:", error);
        res.status(500).send({ message: "Failed to get tracking data" });
      }
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        console.log("decoded", req.decoded);
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "forbidden access" });
        }
        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } };

        const payments = await paymentsCollection
          .find(query, options)
          .toArray();
        res.send(payments);
      } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ message: "Failed to get payments" });
      }
    });

    // Record payment and update parcel status start here
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        // 1. Update parcel's payment_status
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: "paid",
            },
          }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        // 2. Insert payment record
        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment processing failed:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });
    // Record payment and update parcel status end here

    app.post("/create-payment-intent", async (req, res) => {
      const amountInCents = req.body.amountInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //Update a parcel by ID
    app.patch("/parcels/:id", async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid parcel ID" });
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send({
          message: "Parcel updated successfully",
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error updating parcel:", error);
        res.status(500).send({ message: "Failed to update parcel" });
      }
    });

    // Delete a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Failed to delete parcel" });
      }
    });
    // riders related APIs
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    app.get("/riders/pending", async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();

        res.send(pendingRiders);
      } catch (error) {
        console.error("Failed to load pending riders:", error);
        res.status(500).send({ message: "Failed to load pending riders" });
      }
    });
    app.get("/riders/active", async (req, res) => {
      const result = await ridersCollection
        .find({ status: "active" })
        .toArray();
      res.send(result);
    });

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status,
        },
      };

      try {
        const result = await ridersCollection.updateOne(query, updateDoc);
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });

    app.get("/dashboard-stats", async (req, res) => {
  try {
    const [userCount, parcelCount, activeRiderCount, pendingRiderCount] = await Promise.all([
      usersCollection.countDocuments(),
      parcelsCollection.countDocuments(),
      ridersCollection.countDocuments({ status: "active" }),
      ridersCollection.countDocuments({ status: "pending" }),
    ]);

    const pendingParcels = await parcelsCollection.countDocuments({ status: "pending" });

    res.send({
      totalUsers: userCount,
      totalParcels: parcelCount,
      pendingParcels,
      activeRiders: activeRiderCount,
      pendingRiders: pendingRiderCount,
    });
  } catch (error) {
    console.error("Failed to load dashboard stats:", error);
    res.status(500).send({ message: "Failed to load dashboard stats" });
  }
});

    // app.post("/tracking", async (req, res) => {
    //   const {
    //     tracking_id,
    //     parcel_id,
    //     status,
    //     message,
    //     updated_by = "",
    //   } = req.body;

    //   const log = {
    //     tracking_id,
    //     parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
    //     status,
    //     message,
    //     time: new Date(),
    //     updated_by,
    //   };

    //   const result = await trackingCollection.insertOne(log);
    //   res.send({ success: true, insertedId: result.insertedId });
    // });

    // user related api
    app.post("/users", async (req, res) => {
      const email = req.body.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        //  Update last log in
        await usersCollection.updateOne(
          { email },
          { $set: { last_log_in: new Date().toISOString() } }
        );

        return res.status(200).send({
          message: "User already exists. last_log_in updated.",
          inserted: false,
        });
      }

      const user = {
        ...req.body,
        created_at: new Date().toISOString(),
        last_log_in: new Date().toISOString(),
      };

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    console.log("Parcel server connected to MongoDB");
  } catch (error) {
    console.error(error);
  }
}

run();

app.get("/", (req, res) => {
  res.send("Parcel Delivery Server is running...");
});

app.listen(port, () => {
  console.log(`Parcel server running on port ${port}`);
});

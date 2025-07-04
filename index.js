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

const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8');
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pw0rah1.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const { ServerApiVersion } = require("mongodb");
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // await client.connect();
    const db = client.db("parcelDB");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingCollection = db.collection("tracking");
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
        console.log(error);
        return res.status(403).send({ message: "forbidden access" });
      }
    };
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      console.log(user);
      if (!user || user.role !== "rider") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };
    // Create new parcel
    app.post("/parcels", async (req, res) => {
      const newParcel = req.body;
      const result = await parcelsCollection.insertOne(newParcel);
      newParcel.createdAt = new Date();
      res.send(result);
    });

    // parcels api
   
    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email} = req.query;
        let query = {};
        if (email) {
          query = { createdBy: email };
        }

        const options = {
          sort: { createdAt: -1 },
        };

        console.log("parcel query", req.query, query);

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    //  Get a specific parcel by ID
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
    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcel_id,
        status,
        message,
        updated_by = "",
      } = req.body;

      const log = {
        tracking_id,
        parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
        status,
        message,
        time: new Date(),
        updated_by,
      };

      const result = await trackingCollection.insertOne(log);
      res.send({ success: true, insertedId: result.insertedId });
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
    app.post("/payments", verifyFBToken, async (req, res) => {
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
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
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
    app.get("/riders/active", verifyFBToken, verifyAdmin, async (req, res) => {
      const result = await ridersCollection
        .find({ status: "active" })
        .toArray();
      res.send(result);
    });
    app.get("/riders/available", async (req, res) => {
      const { district } = req.query;

      try {
        const riders = await ridersCollection
          .find({
            district,
          })
          .toArray();

        res.send(riders);
      } catch (err) {
        res.status(500).send({ message: "Failed to load riders" });
      }
    });
    //  Get pending delivery tasks for a rider
    app.get("/rider/parcels", verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Rider email is required" });
        }

        const query = {
          createdBy: email,
          deliveryStatus: { $in: ["rider_assigned", "in_transit"] },
        };

        const options = {
          sort: { creation_date: -1 },
        };

        const parcels = await parcelsCollection.find(query, options).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching rider tasks:", error);
        res.status(500).send({ message: "Failed to get rider tasks" });
      }
    });

    // Load completed parcel deliveries for a rider
    app.get(
      "/rider/completed-parcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const query = {
            createdBy: email,
            deliveryStatus: {
              $in: ["delivered", "service_center_delivered"],
            },
          };

          const options = {
            sort: { creation_date: -1 },
          };

          const completedParcels = await parcelsCollection
            .find(query, options)
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          console.error("Error loading completed parcels:", error);
          res
            .status(500)
            .send({ message: "Failed to load completed deliveries" });
        }
      }
    );

    app.patch("/parcels/:id/assign", async (req, res) => {
      const parcelId = req.params.id;
      const { riderId, riderName } = req.body;

      try {
        // Update parcel
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              deliveryStatus: "rider_assigned",
              assigned_rider_id: riderId,
              assigned_rider_name: riderName,
            },
          }
        );

        // Update rider
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: "in_delivery",
            },
          }
        );

        res.send({ message: "Rider assigned" });
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to assign rider" });
      }
    });

    app.patch("/riders/:id/status", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status,
        },
      };

      try {
        const result = await ridersCollection.updateOne(query, updateDoc);

        // update user role for accepting rider
        if (status === "active") {
          const userQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await usersCollection.updateOne(
            userQuery,
            userUpdateDoc
          );
          console.log(roleResult.modifiedCount);
        }

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update rider status" });
      }
    });
    // GET: Load completed parcel deliveries for a rider
    app.get(
      "/rider/completed-parcels",
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const email = req.query.email;

          if (!email) {
            return res.status(400).send({ message: "Rider email is required" });
          }

          const query = {
            email: email,
            deliveryStatus: {
              $in: ["delivered", "service_center_delivered"],
            },
          };

          const options = {
            sort: { creation_date: -1 },
          };

          const completedParcels = await parcelsCollection
            .find(query, options)
            .toArray();

          res.send(completedParcels);
        } catch (error) {
          console.error("Error loading completed parcels:", error);
          res
            .status(500)
            .send({ message: "Failed to load completed deliveries" });
        }
      }
    );
    app.patch("/parcels/:id/cashout", async (req, res) => {
      const id = req.params.id;
      const result = await parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            cashout_status: "cashed_out",
            cashed_out_at: new Date(),
          },
        }
      );
      res.send(result);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const parcelId = req.params.id;
      const { status } = req.body;
      const updatedDoc = {
        deliveryStatus: status,
      };

      if (status === "in_transit") {
        updatedDoc.picked_at = new Date().toISOString();
      } else if (status === "delivered") {
        updatedDoc.delivered_at = new Date().toISOString();
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: updatedDoc,
          }
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to update status" });
      }
    });
    app.get("/users/search", async (req, res) => {
      const emailQuery = req.query.email;
      if (!emailQuery) {
        return res.status(400).send({ message: "Missing email query" });
      }

      const regex = new RegExp(emailQuery, "i");

      try {
        const users = await usersCollection
          .find({ email: { $regex: regex } })
          // .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray();
        res.send(users);
      } catch (error) {
        console.error("Error searching users", error);
        res.status(500).send({ message: "Error searching users" });
      }
    });
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;

        if (!["admin", "user"].includes(role)) {
          return res.status(400).send({ message: "Invalid role" });
        }

        try {
          const result = await usersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );
          res.send({ message: `User role updated to ${role}`, result });
        } catch (error) {
          console.error("Error updating user role", error);
          res.status(500).send({ message: "Failed to update user role" });
        }
      }
    );
    // GET: Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role:", error);
        res.status(500).send({ message: "Failed to get role" });
      }
    });
    // admin, rider and user dashboard related APIs here
    app.get("/parcels/delivery/status-count", async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: "$deliveryStatus",
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/parcels/rider/status-count", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email is required" });

      // Get rider name from DB
      const rider = await ridersCollection.findOne({ email });
      if (!rider) return res.status(404).send({ message: "Rider not found" });

      const pipeline = [
        { $match: { assigned_rider_name: rider.name } },
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/parcels/user/status-count", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email is required" });

      const pipeline = [
        {
          $match: {
            createdBy: email,
            paymentStatus: "paid",
          },
        },
        {
          $group: {
            _id: "$deliveryStatus",
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            status: "$_id",
            count: 1,
            _id: 0,
          },
        },
      ];

      const result = await parcelsCollection.aggregate(pipeline).toArray();
      res.send(result);
    });

    app.get("/payments/user/summary", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email required" });

      const paidCount = await paymentsCollection.countDocuments({ email });
      const totalPaid = await paymentsCollection
        .aggregate([
          { $match: { email } },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
            },
          },
        ])
        .toArray();

      res.send({
        paidCount,
        totalPaid: totalPaid[0]?.total || 0,
      });
    });
    app.get("/parcels/user/recent", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email required" });

      const recent = await parcelsCollection
        .find({ createdBy: email })
        .sort({ _id: -1 })
        .limit(5)
        .toArray();

      res.send(recent);
    });
    app.get("/payments/user/recent", async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email required" });

      const recent = await paymentsCollection
        .find({ email })
        .sort({ paid_at: -1 })
        .limit(5)
        .toArray();

      res.send(recent);
    });

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
    // users can update their profile
    app.patch("/users/update-profile", async (req, res) => {
  const { email, newName, newEmail, newPhoto } = req.body;

  if (!email) {
    return res.status(400).send({ message: "Current email is required" });
  }

  const updateDoc = {
    last_log_in: new Date().toISOString(), 
  };

  if (newName) updateDoc.name = newName;
  if (newEmail) updateDoc.email = newEmail;
  if (newPhoto) updateDoc.photo = newPhoto;

  try {
    const result = await usersCollection.updateOne(
      { email },
      { $set: updateDoc }
    );

    res.send({
      message: "Profile and last_log_in updated successfully",
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    res.status(500).send({ message: "Failed to update user", error: err });
  }
});


    // Get user profile by email
    app.get("/users/profile", async (req, res) => {
      const email = req.query.email;
      if (!email) return res.status(400).send({ message: "Email is required" });

      const user = await usersCollection.findOne({ email });
      if (!user) return res.status(404).send({ message: "User not found" });

      // Send only needed info
      res.send({
        email: user.email,
        name: user.name,
        role: user.role,
        last_log_in: user.last_log_in,
      });
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


const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ObjectId } = require('mongodb');

// config
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();
    const db = client.db('parcel_delivery');
    const parcelsCollection = db.collection('parcels');

   

    console.log('Parcel server connected to MongoDB');
  } catch (error) {
    console.error(error);
  }
}

run();

app.get('/', (req, res) => {
  res.send('Parcel Delivery Server is running...');
});

app.listen(port, () => {
  console.log(`Parcel server running on port ${port}`);
});

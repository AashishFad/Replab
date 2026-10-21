import dns from 'node:dns';
import mongoose from 'mongoose';

/**
 * Configure reliable DNS resolvers for MongoDB Atlas SRV record lookups.
 * On Windows and certain ISP routers, local DNS servers often refuse or drop
 * SRV records with 'querySrv ECONNREFUSED'. Setting standard public resolvers
 * resolves this issue cleanly.
 */
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (dnsErr) {
  // If setServers fails in constrained network environments, fall back to default
}

const readyStateMap = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

/**
 * Returns current database connection details.
 * @returns {{ connected: boolean, status: string, readyState: number, host: string | null, dbName: string | null }}
 */
export const getConnectionStatus = () => {
  const readyState = mongoose.connection.readyState;
  const isConnected = readyState === 1;

  return {
    connected: isConnected,
    status: readyStateMap[readyState] || 'unknown',
    readyState,
    host: isConnected ? mongoose.connection.host : null,
    dbName: isConnected ? mongoose.connection.name : null,
  };
};

/**
 * Connects to MongoDB Atlas using the URI specified in the environment variables.
 * Handles missing configuration gracefully without crashing the server.
 */
export const connectDB = async () => {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.warn(
      '[MongoDB] Warning: MONGODB_URI is not defined in the environment variables.\n' +
      '           The API will start in degraded mode with database disconnected.\n' +
      '           Please configure MONGODB_URI in your server/.env file.'
    );
    return false;
  }

  // Register connection event listeners
  mongoose.connection.on('connected', () => {
    console.log(`[MongoDB] Connected successfully to host: ${mongoose.connection.host} (${mongoose.connection.name})`);
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[MongoDB] Connection error: ${err.message}`);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[MongoDB] Connection lost / disconnected.');
  });

  try {
    console.log('[MongoDB] Attempting to connect to MongoDB Atlas...');
    await mongoose.connect(uri, {
      dbName: process.env.DB_NAME || 'replicalab',
      serverSelectionTimeoutMS: 8000,
    });
    return true;
  } catch (error) {
    console.error(`[MongoDB] Connection failed: ${error.message}`);

    if (error.message.includes('querySrv') || error.message.includes('ECONNREFUSED')) {
      console.error(
        '[MongoDB] DNS SRV Lookup issue detected. Ensure your machine allows DNS queries to 8.8.8.8 or 1.1.1.1.'
      );
    } else if (error.message.includes('bad auth') || error.message.includes('Authentication failed')) {
      console.error(
        '[MongoDB] Authentication failed. Check your database username and password in server/.env.'
      );
    } else {
      console.error(
        '[MongoDB] Ensure your current IP is whitelisted in MongoDB Atlas Network Access.'
      );
    }

    return false;
  }
};

/**
 * Gracefully disconnects from MongoDB (e.g., during process termination).
 */
export const disconnectDB = async () => {
  try {
    await mongoose.connection.close();
    console.log('[MongoDB] Connection closed through app termination.');
  } catch (error) {
    console.error(`[MongoDB] Error closing connection: ${error.message}`);
  }
};

const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  console.log('Auth middleware called');
  const authHeader = req.headers.authorization;
  console.log('Authorization header:', authHeader);

  if (!authHeader) {
    console.log('Authorization header missing');
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];
  console.log('Extracted token:', token);

  if (!token) {
    console.log('Token missing in Authorization header');
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const secret = process.env.JWT_SECRET || 'SECRET_KEY';
    console.log('Using JWT secret:', secret);
    const decoded = jwt.verify(token, secret);
    console.log('Decoded token:', decoded);
    req.user = decoded;  // Add user data to request object
    next();
  } catch (error) {
    console.error('JWT verification failed:', error.message);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;

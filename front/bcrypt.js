//https://stackoverflow.com/questions/14015677/node-js-encryption-of-passwords
var bcrypt = require('bcrypt');
module.exports = {
  cryptPassword: function(password, callback) {
     bcrypt.genSalt(10, function(err, salt) {
      if (err)
        return callback(err);

      bcrypt.hash(password, salt, function(err, hash) {
        return callback(err, hash);
      });

    });
  },
  comparePassword: function(password, userPassword, callback) {
     bcrypt.compare(password, userPassword, function(err, isPasswordMatch) {
        if (err)
          return callback(err);
        return callback(null, isPasswordMatch);
     });
  }
};

module.exports = {
  name: '021_add_message_forward',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN forwarded_from_name TEXT;
    `);
  }
};

/**
 * Sample database: a small online shop. Entirely fictional.
 *
 * The data deliberately contains NULLs and "orphan" rows so that INNER, LEFT, RIGHT
 * and FULL OUTER joins return different results:
 *   - supplier 4 (Northwind Paper) supplies no products
 *   - product 9 (Desk Lamp) has no supplier (supplier_id is NULL)
 *   - product 10 (Sticky Notes) has never been ordered
 *   - customer 6 (Farah Haddad) has no orders; customers 3 and 7 have no city
 *   - order 1009 is a guest checkout (customer_id is NULL)
 *   - several order lines have no discount (NULL), and two products share a price
 */

export const SHOP_TABLES = {
  customers: {
    columns: ['customer_id', 'name', 'city', 'tier', 'signup_year'],
    types: ['INTEGER', 'TEXT', 'TEXT', 'TEXT', 'INTEGER'],
    primaryKey: ['customer_id'],
    rows: [
      [1, 'Ava Chen', 'Lisbon', 'gold', 2021],
      [2, 'Ben Okafor', 'Porto', 'silver', 2022],
      [3, 'Chloe Martin', null, 'bronze', 2023],
      [4, 'Diego Ruiz', 'Lisbon', 'silver', 2021],
      [5, 'Emma Novak', 'Braga', 'gold', 2020],
      [6, 'Farah Haddad', 'Porto', 'bronze', 2024],
      [7, 'Gus Lindqvist', null, 'silver', 2023],
    ],
  },
  suppliers: {
    columns: ['supplier_id', 'name', 'country'],
    types: ['INTEGER', 'TEXT', 'TEXT'],
    primaryKey: ['supplier_id'],
    rows: [
      [1, 'Acme Office', 'Portugal'],
      [2, 'Blue River Trading', 'Spain'],
      [3, 'Cedar Works', 'Portugal'],
      [4, 'Northwind Paper', 'France'],
    ],
  },
  products: {
    columns: ['product_id', 'name', 'category', 'price', 'supplier_id', 'stock'],
    types: ['INTEGER', 'TEXT', 'TEXT', 'REAL', 'INTEGER', 'INTEGER'],
    primaryKey: ['product_id'],
    rows: [
      [1, 'Ballpoint Pen', 'stationery', 1.5, 1, 500],
      [2, 'Notebook A5', 'stationery', 4.25, 1, 120],
      [3, 'Office Chair', 'furniture', 129.0, 3, 8],
      [4, 'Standing Desk', 'furniture', 349.99, 3, 0],
      [5, 'USB-C Cable', 'electronics', 9.99, 2, 75],
      [6, 'Wireless Mouse', 'electronics', 24.5, 2, 40],
      [7, 'Monitor Arm', 'furniture', 59.0, 3, 15],
      [8, 'Highlighter Set', 'stationery', 4.25, 1, 60],
      [9, 'Desk Lamp', 'furniture', 39.9, null, 22],
      [10, 'Sticky Notes', 'stationery', 2.1, 1, null],
    ],
  },
  orders: {
    columns: ['order_id', 'customer_id', 'order_date', 'status'],
    types: ['INTEGER', 'INTEGER', 'TEXT', 'TEXT'],
    primaryKey: ['order_id'],
    rows: [
      [1001, 1, '2025-01-05', 'delivered'],
      [1002, 2, '2025-01-09', 'delivered'],
      [1003, 1, '2025-02-14', 'shipped'],
      [1004, 4, '2025-02-20', 'cancelled'],
      [1005, 5, '2025-03-02', 'delivered'],
      [1006, 3, '2025-03-15', 'pending'],
      [1007, 5, '2025-03-28', 'shipped'],
      [1008, 7, '2025-04-03', 'delivered'],
      [1009, null, '2025-04-11', 'delivered'],
    ],
  },
  order_items: {
    columns: ['order_id', 'product_id', 'quantity', 'unit_price', 'discount'],
    types: ['INTEGER', 'INTEGER', 'INTEGER', 'REAL', 'REAL'],
    primaryKey: ['order_id', 'product_id'],
    rows: [
      [1001, 1, 10, 1.5, null],
      [1001, 2, 3, 4.25, 0.1],
      [1002, 3, 1, 129.0, null],
      [1002, 7, 2, 59.0, 0.05],
      [1003, 5, 4, 9.99, null],
      [1003, 6, 1, 24.5, null],
      [1004, 4, 1, 349.99, 0.15],
      [1005, 2, 5, 4.25, null],
      [1005, 8, 2, 4.25, null],
      [1005, 9, 1, 39.9, 0.2],
      [1006, 1, 20, 1.5, 0.1],
      [1007, 3, 2, 129.0, 0.1],
      [1007, 6, 2, 24.5, null],
      [1008, 5, 1, 9.99, null],
      [1009, 1, 5, 1.5, null],
    ],
  },
};

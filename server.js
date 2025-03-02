const express = require('express');
const { Pool } = require('pg');
const NodeCache = require('node-cache');
require('dotenv').config();
const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 6000;

// إعداد اتصال PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'store_db',
  password: process.env.DB_PASS || '1234',
  port: process.env.DB_PORT || 5432,
});

// Middleware مع زيادة حجم الـ payload
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ---------- الروتات ----------

// ---------- Routes للطلبات ----------

// POST إنشاء طلب جديد
app.post('/store/orders', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { user_id, items } = req.body;
      
      const orderRes = await client.query(
        'INSERT INTO orders (user_id) VALUES ($1) RETURNING *',
        [user_id]
      );
      
      for (const item of items) {
        await client.query(
          `INSERT INTO order_items 
          (order_id, product_id, quantity, price)
          VALUES ($1, $2, $3, (SELECT price FROM products WHERE id = $2))`,
          [orderRes.rows[0].id, item.product_id, item.quantity]
        );
      }
      
      await client.query('COMMIT');
      res.status(201).json(orderRes.rows[0]);
      
    } catch (err) {
      // ...
    }
  });
  // GET جميع الطلبات مع التفاصيل
  app.get('/store/orders', async (req, res) => {
    try {
      const { rows: orders } = await pool.query(`
        SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'quantity', oi.quantity,
          'price', oi.price
        )) AS items
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        GROUP BY o.id
      `);
      
      res.json(orders);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // GET طلب معين مع التفاصيل
  app.get('/api/orders/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'quantity', oi.quantity,
          'price', oi.price
        )) AS items
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        WHERE o.id = $1
        GROUP BY o.id
      `, [req.params.id]);
      
      if (rows.length === 0) {
        return res.status(404).json({ message: 'الطلب غير موجود' });
      }
      
      res.json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });

// ------ اقتراحات المنتجات المرتبطة ------
app.get('/api/products/:id/suggestions', async (req, res) => {
  try {
      const { id } = req.params;
      const minSupport = req.query.min_support || 0.1; // الحد الأدنى للدعم

      const { rows } = await pool.query(`
          WITH product_orders AS (
              SELECT DISTINCT order_id
              FROM order_items
              WHERE product_id = $1
          ),
          co_occurrences AS (
              SELECT 
                  oi.product_id,
                  COUNT(DISTINCT oi.order_id) AS co_occurrence_count,
                  (COUNT(DISTINCT oi.order_id) * 1.0) / (SELECT COUNT(*) FROM product_orders) AS support
              FROM product_orders po
              JOIN order_items oi ON po.order_id = oi.order_id
              WHERE oi.product_id != $1
              GROUP BY oi.product_id
          )
          SELECT 
              p.id,
              p.name, 
              p.price,
              p.description,
              p.category,
              p.image_url,
              co.support,
              AVG(oi.price) AS avg_price
          FROM co_occurrences co
          JOIN products p ON co.product_id = p.id
          JOIN order_items oi ON oi.product_id = p.id
          WHERE co.support >= $2
          GROUP BY p.id, co.support
          ORDER BY co.support DESC
          LIMIT 5;
      `, [id, minSupport]);

      res.json(rows);
  } catch (err) {
      handleServerError(res, err);
  }
});

// ------ العلاقات الأكثر تكرارا ------
app.get('/api/associations', async (req, res) => {
    try {
        const cached = cache.get('associations');
        
        if (cached) {
            return res.json(cached);
        }

        const { rows } = await pool.query(`
            SELECT 
                p1.name AS product1,
                p2.name AS product2,
                pa.frequency
            FROM product_associations pa
            JOIN products p1 ON pa.product1 = p1.id
            JOIN products p2 ON pa.product2 = p2.id
            ORDER BY pa.frequency DESC
            LIMIT 10
        `);

        cache.set('associations', rows);
        res.json(rows);
        
    } catch (err) {
        handleServerError(res, err);
    }
});

// GET جميع المستخدمين
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users');
    res.json(rows);
  } catch (err) {
    handleServerError(res, err);
  }
});

// GET مستخدم بواسطة ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// POST إضافة مستخدم جديد
app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'الاسم مطلوب' });
    }

    const { rows } = await pool.query(
      'INSERT INTO users (name) VALUES ($1) RETURNING *',
      [name]
    );
    
    res.status(201).json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// PUT تحديث مستخدم
app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'الاسم مطلوب' });
    }
    
    const { rows } = await pool.query(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING *',
      [name, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// DELETE حذف مستخدم
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    
    if (rowCount === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.status(204).send();
  } catch (err) {
    handleServerError(res, err);
  }
});

// معالجة الأخطاء
const handleServerError = (res, err) => {
  console.error(err);
  res.status(500).json({
    error: 'خطأ في الخادم',
    message: err.message
  });
};

// تشغيل الخادم
// تشغيل الخادم



/////////////////
// ---------- Routes للـ Products ----------

// // GET جميع المنتجات
// app.get('/api/products', async (req, res) => {
//   try {
//     const { 
//       q,
//       page = 1,
//       limit = 8
//     } = req.query;

//     const offset = (page - 1) * limit;
//     let query = 'SELECT * FROM products';
//     let params = [];
//     let whereConditions = [];

//     if (q) {
//       const searchTerms = q.split(' ').filter(term => term);
//       whereConditions = searchTerms.map((term, index) => 
//         `(name ILIKE $${index + 1} OR description ILIKE $${index + 1} OR category ILIKE $${index + 1})`
//       );
//       params.push(...searchTerms.map(term => `%${term}%`));
//     }

//     if (whereConditions.length > 0) {
//       query += ` WHERE ${whereConditions.join(' AND ')}`;
//     }

//     query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
//     params.push(limit, offset);

//     // الحصول على البيانات
//     const { rows } = await pool.query(query, params);

//     // الحصول على العدد الإجمالي
//     const countQuery = `SELECT COUNT(*) FROM products ${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}`;
//     const countResult = await pool.query(countQuery, params.slice(0, -2));

//     res.json({
//       page: parseInt(page),
//       limit: parseInt(limit),
//       total: parseInt(countResult.rows[0].count),
//       totalPages: Math.ceil(countResult.rows[0].count / limit),
//       data: rows
//     });

//   } catch (err) {
//     handleServerError(res, err);
//   }
// });

  app.get('/api/products/:id', async (req, res) => {
    try {
      const productId = req.params.id;
      
      // التحقق من أن ال ID رقم صحيح
      if (!Number.isInteger(Number(productId))) {
        return res.status(400).json({ message: 'معرف المنتج غير صالح' });
      }
  
      const query = 'SELECT * FROM products WHERE id = $1';
      const { rows } = await pool.query(query, [productId]);
  
      if (rows.length === 0) {
        return res.status(404).json({ message: 'المنتج غير موجود' });
      }
  
      res.json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // POST إضافة منتج جديد
  app.post('/api/products', async (req, res) => {
    try {
      const { name, description, category, price, image_url } = req.body;
      
      if (!name || !category || !price) {
        return res.status(400).json({ message: 'الحقول name, category, price مطلوبة' });
      }
  
      const { rows } = await pool.query(
        `INSERT INTO products (name, description, category, price, image_url)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, description, category, price, image_url]
      );
      
      res.status(201).json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // PUT تحديث منتج
  app.put('/api/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, category, price, image_url } = req.body;
  
      const { rows } = await pool.query(
        `UPDATE products 
         SET name = $1, description = $2, category = $3, price = $4, image_url = $5 
         WHERE id = $6 RETURNING *`,
        [name, description, category, price, image_url, id]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ message: 'المنتج غير موجود' });
      }
      
      res.json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // DELETE حذف منتج
  app.delete('/api/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
      
      if (rowCount === 0) {
        return res.status(404).json({ message: 'المنتج غير موجود' });
      }
      
      res.status(204).send();
    } catch (err) {
      handleServerError(res, err);
    }
  });
  /// get all categories
  // GET جميع الفئات المميزة
app.get('/api/categories', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT DISTINCT(category) FROM products ORDER BY category ASC'
      );
      
      const categories = rows.map(row => row.category);
      res.json(categories);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  app.get('/api/products', async (req, res) => {
    try {
      const { category, q, page = 1, limit = 8 } = req.query;
      const offset = (page - 1) * limit;
      
      const parsedPage = Math.max(1, parseInt(page));
      const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
  
      let baseQuery = `
        SELECT 
          id, 
          name, 
          description, 
          category, -- إزالة TRIM لتبسيط البيانات
          price::text, -- استخدام النص بدل numeric
          image_url
        FROM products
      `;
  
      const whereClauses = [];
      const queryParams = [];
  
      if (category && category.trim().toLowerCase() !== 'الكل') {
        whereClauses.push(`category ILIKE $${queryParams.length + 1}`);
        queryParams.push(`%${category.trim()}%`);
      }
  
      if (q && q.trim().length > 0) {
        queryParams.push(`%${q.trim()}%`);
        whereClauses.push(`(name ILIKE $${queryParams.length} OR description ILIKE $${queryParams.length})`);
      }
  
      if (whereClauses.length > 0) {
        baseQuery += ` WHERE ${whereClauses.join(' AND ')}`;
      }
  
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM products
        ${whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : ''}
      `;
      
      const dataQuery = `
        ${baseQuery}
        ORDER BY id DESC
        LIMIT $${queryParams.length + 1}
        OFFSET $${queryParams.length + 2}
      `;
  
      const [countResult, dataResult] = await Promise.all([
        pool.query(countQuery, queryParams),
        pool.query(dataQuery, [...queryParams, parsedLimit, offset])
      ]);
  
      res.json({
        success: true,
        page: parsedPage,
        limit: parsedLimit,
        totalItems: Number(countResult.rows[0].total),
        totalPages: Math.ceil(Number(countResult.rows[0].total) / parsedLimit),
        data: dataResult.rows
      });
  
    } catch (err) {
      console.error('فشل جلب المنتجات:', err);
      res.status(500).json({ success: false, message: 'خطأ في الخادم' });
    }
  });

  pool.query('SELECT NOW()', (err) => {
    if (err) {
      console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
    } else {
      console.log('✅ تم الاتصال بنجاح مع قاعدة البيانات PostgreSQL');
    }
  });
  app.listen(PORT, () => {
    console.log(`🟢 الخادم يعمل على المنفذ ${PORT}`);
  });
  // اختبار الاتصال مع قاعدة البيانات

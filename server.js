{
  "version": 2,
  "builds": [
    {
      "src": "servidor.js",
      "use": "@vercel/node",
      "config": {
        "includeFiles": ["index.html"]
      }
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/servidor.js"
    }
  ]
}

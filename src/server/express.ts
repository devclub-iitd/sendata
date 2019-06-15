import * as bodyParser from "body-parser";
import * as express from "express";
import * as expressLayout from "express-ejs-layouts";
import * as path from "path";
import PORT from "./env";

export default function init() {
    const app: express.Application = express();
    app.set("port", PORT);
    app.use(bodyParser.urlencoded({
        extended: true,
    }));
    app.use(express.static("public"));
    // EJS
    app.use(expressLayout);
    app.set("view engine", "ejs");
    app.set("layout", "layout.ejs");
    // body parser
    app.use(bodyParser.json());
    app.get("/", (req, res) => {
        // res.sendFile(path.resolve(__dirname + "/../../public/index.html"));
        res.render("login");
    });
    return app;
}
